// process-queue.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Configuración
const BATCH_SIZE = 500;
const CHUNK_SIZE = 100;
const CONCURRENT_REQUESTS = 5;

// Configurar Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log('🚀 Process Queue Service Starting...');
console.log('📍 Supabase URL:', process.env.SUPABASE_URL);
console.log('⚙️  Batch size:', BATCH_SIZE);
console.log('⚙️  Chunk size:', CHUNK_SIZE);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'process-queue',
    status: 'healthy',
    config: {
      batchSize: BATCH_SIZE,
      chunkSize: CHUNK_SIZE,
      concurrentRequests: CONCURRENT_REQUESTS
    },
    timestamp: new Date().toISOString()
  });
});

// Queue processing endpoint
app.post('/process-queue', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('🔄 Starting queue processing...');

    // 1. Obtener notificaciones pendientes
    const { data: notifications, error: fetchError } = await supabase
      .from('notification_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('scheduled_for', { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error('❌ Error fetching notifications:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    if (!notifications || notifications.length === 0) {
      console.log('✅ No pending notifications');
      return res.json({ ok: true, processed: 0 });
    }

    console.log(`📦 Found ${notifications.length} pending notifications`);

    const notificationIds = notifications.map(n => n.id);

    // 2. Marcar como processing
    const { error: updateError } = await supabase
      .from('notification_queue')
      .update({ status: 'processing' })
      .in('id', notificationIds);

    if (updateError) {
      console.error('❌ Error updating status:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    // 3. Agrupar notificaciones por usuario
    const byUser = {};
    for (const notif of notifications) {
      if (!byUser[notif.user_id]) {
        byUser[notif.user_id] = [];
      }
      byUser[notif.user_id].push(notif);
    }

    const uniqueUsers = Object.keys(byUser).length;
    console.log(`👥 Notifications for ${uniqueUsers} unique user(s)`);

    // 4. Obtener tokens activos de esos usuarios
    const userIds = Object.keys(byUser);
    const { data: tokens, error: tokensError } = await supabase
      .from('profile_push_tokens')
      .select('user_id, expo_push_token, device_name')
      .in('user_id', userIds)
      .eq('is_active', true);

    if (tokensError) {
      console.error('❌ Error fetching tokens:', tokensError);
      return res.status(500).json({ error: tokensError.message });
    }

    console.log(`📱 Found ${tokens?.length || 0} active token(s)`);

    // Mapear tokens por usuario
    const tokensByUser = {};
    for (const token of tokens || []) {
      if (!tokensByUser[token.user_id]) {
        tokensByUser[token.user_id] = [];
      }
      tokensByUser[token.user_id].push(token.expo_push_token);
    }

    // 5. Crear mensajes para Expo
    const messages = [];
    const notificationToTokens = {};

    for (const [userId, userNotifications] of Object.entries(byUser)) {
      const userTokens = tokensByUser[userId] || [];
      
      if (userTokens.length === 0) {
        console.log(`⚠️  User ${userId} has no active tokens`);
        continue;
      }

      for (const notification of userNotifications) {
        for (const token of userTokens) {
          messages.push({
            to: token,
            sound: 'default',
            title: notification.title,
            body: notification.body,
            data: notification.data || {},
            priority: notification.priority || 'default',
            channelId: notification.category
          });

          if (!notificationToTokens[notification.id]) {
            notificationToTokens[notification.id] = [];
          }
          notificationToTokens[notification.id].push(token);
        }
      }
    }

    console.log(`📤 Prepared ${messages.length} push message(s)`);

    if (messages.length === 0) {
      console.log('⚠️  No messages to send');
      await supabase
        .from('notification_queue')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .in('id', notificationIds);
      
      return res.json({ ok: true, processed: notifications.length, sent: 0 });
    }

    // 6. Enviar en chunks a Expo
    let totalSent = 0;
    const invalidTokens = new Set();

    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      console.log(`📨 Sending chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(messages.length/CHUNK_SIZE)} (${chunk.length} messages)`);

      try {
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate'
          },
          body: JSON.stringify(chunk)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('❌ Expo API error:', response.status, errorText);
          continue;
        }

        const result = await response.json();
        totalSent += chunk.length;

        // Detectar tokens inválidos
        if (result.data) {
          for (let j = 0; j < result.data.length; j++) {
            const ticket = result.data[j];
            if (ticket.status === 'error' && 
                ticket.details?.error === 'DeviceNotRegistered') {
              const invalidToken = chunk[j].to;
              invalidTokens.add(invalidToken);
              console.log('🗑️  Detected invalid token:', invalidToken);
            }
          }
        }

      } catch (error) {
        console.error('💥 Error sending chunk:', error);
      }

      // Pequeña pausa entre chunks para no saturar
      if (i + CHUNK_SIZE < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 7. Desactivar tokens inválidos
    if (invalidTokens.size > 0) {
      console.log(`🗑️  Deactivating ${invalidTokens.size} invalid token(s)`);
      await supabase
        .from('profile_push_tokens')
        .update({ is_active: false })
        .in('expo_push_token', Array.from(invalidTokens));
    }

    // 8. Marcar notificaciones como enviadas
    const { error: finalUpdateError } = await supabase
      .from('notification_queue')
      .update({ 
        status: 'sent', 
        sent_at: new Date().toISOString() 
      })
      .in('id', notificationIds);

    if (finalUpdateError) {
      console.error('❌ Error marking as sent:', finalUpdateError);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Queue processing completed in ${duration}ms`);
    console.log(`📊 Stats: ${notifications.length} notifications, ${totalSent} messages sent`);

    res.json({ 
      ok: true, 
      processed: notifications.length,
      sent: totalSent,
      invalidTokens: invalidTokens.size,
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Process Queue Service running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
  console.log(`🔗 Process URL: http://localhost:${PORT}/process-queue`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
