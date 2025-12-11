// chatwoot-webhook.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Configurar Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🚀 Chatwoot Webhook Service Starting...');
console.log('📍 Supabase URL:', process.env.SUPABASE_URL);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'chatwoot-webhook',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Webhook endpoint
app.post('/chatwoot-webhook', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('📨 Webhook received:', JSON.stringify(req.body, null, 2));

    const { event, message_type, content, sender, contact } = req.body;

    // Filtrar eventos no relevantes
    if (event !== 'message_created' || message_type !== 'incoming') {
      console.log('⏭️  Event ignored:', event, message_type);
      return res.json({ ok: true, message: 'Event ignored' });
    }

    if (sender?.type !== 'User') {
      console.log('⏭️  Message not from user');
      return res.json({ ok: true, message: 'Not from user' });
    }

    const userId = contact?.identifier;
    if (!userId) {
      console.error('❌ Missing user identifier');
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    console.log('👤 Processing message for user:', userId);

    // Obtener tokens del usuario
    const { data: tokens, error: tokensError } = await supabase
      .from('profile_push_tokens')
      .select('expo_push_token, device_name')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (tokensError) {
      console.error('❌ Error fetching tokens:', tokensError);
      return res.status(500).json({ error: tokensError.message });
    }

    if (!tokens || tokens.length === 0) {
      console.log('⚠️  No active tokens found for user');
      return res.json({ ok: true, message: 'No active tokens' });
    }

    console.log(`📱 Found ${tokens.length} active token(s)`);

    // Crear mensajes para Expo
    const messages = tokens.map(t => ({
      to: t.expo_push_token,
      sound: 'default',
      title: '💬 Nuevo mensaje',
      body: content || 'Tienes un nuevo mensaje en el chat',
      data: { 
        type: 'chat_message', 
        userId,
        timestamp: new Date().toISOString()
      },
      priority: 'high',
      channelId: 'chat'
    }));

    // Enviar notificaciones a Expo
    console.log('📤 Sending push notifications to Expo...');
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate'
      },
      body: JSON.stringify(messages)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Expo API error:', response.status, errorText);
      return res.status(500).json({ error: 'Expo API error', details: errorText });
    }

    const result = await response.json();
    console.log('✅ Push sent successfully:', result);

    // Detectar y limpiar tokens inválidos
    if (result.data) {
      for (let i = 0; i < result.data.length; i++) {
        const ticket = result.data[i];
        if (ticket.status === 'error' && 
            ticket.details?.error === 'DeviceNotRegistered') {
          const invalidToken = messages[i].to;
          console.log('🗑️  Deactivating invalid token:', invalidToken);
          
          await supabase
            .from('profile_push_tokens')
            .update({ is_active: false })
            .eq('expo_push_token', invalidToken);
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(`⏱️  Request completed in ${duration}ms`);

    res.json({ 
      ok: true, 
      sent: tokens.length,
      duration_ms: duration
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('💥 Fatal error:', error);
    res.status(500).json({ 
      error: error.message,
      duration_ms: duration
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Chatwoot Webhook Service running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/chatwoot-webhook`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
