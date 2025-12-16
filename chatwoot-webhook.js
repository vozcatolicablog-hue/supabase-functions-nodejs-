// Chatwoot Webhook Handler
// Receives messages from Chatwoot and saves them to consultation_messages table
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Main handler for Chatwoot webhooks
 */
async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const webhook = req.body;
    
    console.log('📥 Received Chatwoot webhook:', {
      event: webhook.event,
      conversation_id: webhook.conversation?.id,
      message_id: webhook.message?.id
    });

    // Only process message creation events
    if (webhook.event !== 'message_created') {
      console.log('⏭️  Skipping non-message event:', webhook.event);
      return res.status(200).json({ 
        success: true, 
        message: 'Event ignored' 
      });
    }

    const message = webhook.message;
    const conversation = webhook.conversation;

    // Skip if message is outgoing (sent by us)
    if (message.message_type === 'outgoing') {
      console.log('⏭️  Skipping outgoing message');
      return res.status(200).json({ 
        success: true, 
        message: 'Outgoing message ignored' 
      });
    }

    // Find consultation by Chatwoot conversation ID
    const { data: consultation, error: consultationError } = await supabase
      .from('consultations')
      .select('id, user_id, consultant_id')
      .eq('chatwoot_conversation_id', conversation.id.toString())
      .single();

    if (consultationError || !consultation) {
      console.error('❌ Consultation not found for conversation:', conversation.id);
      return res.status(404).json({ 
        error: 'Consultation not found',
        conversation_id: conversation.id 
      });
    }

    console.log('✅ Found consultation:', consultation.id);

    // Determine message sender
    // If message is from contact (user), use user_id
    // If message is from agent (consultant), use consultant_id or system
    let senderId = consultation.user_id; // Default to user
    let messageType = 'user';

    // Check if message is from an agent
    if (message.sender && message.sender.type === 'agent') {
      // If consultant is assigned, use consultant_id, otherwise mark as system
      if (consultation.consultant_id) {
        senderId = consultation.consultant_id;
        messageType = 'consultant';
      } else {
        // Use the first admin/author as fallback
        const { data: admin } = await supabase
          .from('profiles')
          .select('id')
          .in('role', ['admin', 'author'])
          .limit(1)
          .single();
        
        if (admin) {
          senderId = admin.id;
          messageType = 'consultant';
        } else {
          senderId = consultation.user_id;
          messageType = 'system';
        }
      }
    }

    // Save message to consultation_messages
    const { data: savedMessage, error: messageError } = await supabase
      .from('consultation_messages')
      .insert({
        consultation_id: consultation.id,
        user_id: senderId,
        content: message.content,
        message_type: messageType,
        is_read: false
      })
      .select()
      .single();

    if (messageError) {
      console.error('❌ Error saving message:', messageError);
      return res.status(500).json({ 
        error: 'Failed to save message',
        details: messageError.message 
      });
    }

    console.log('✅ Message saved:', savedMessage.id);

    // Update consultation updated_at timestamp (triggers automatically via trigger)
    
    return res.status(200).json({
      success: true,
      message_id: savedMessage.id,
      consultation_id: consultation.id
    });

  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

module.exports = handler;
