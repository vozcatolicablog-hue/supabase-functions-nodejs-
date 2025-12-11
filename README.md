# Supabase Functions - Node.js Services

Servicios de notificaciones para EEO App.

## Servicios

- **chatwoot-webhook**: Notificaciones transaccionales desde Chatwoot
- **process-queue**: Procesamiento de cola de notificaciones masivas

## Instalación

```bash
npm install
```

## Configuración

Crea un archivo `.env`:

```env
SUPABASE_URL=https://tu-supabase.tu-dominio.com
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
PORT=3000
```

## Desarrollo

```bash
# Chatwoot webhook
npm run dev:chatwoot

# Process queue
npm run dev:queue
```

## Producción

```bash
# Chatwoot webhook
npm run start:chatwoot

# Process queue
npm run start:queue
```
