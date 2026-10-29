# LeadSocial

Sistema de captación de leads para las redes sociales de comercios (Instagram, TikTok y WhatsApp).

Cada comercio tiene:

- **Página de captación** (`/c/<comercio>`) pensada para el enlace de la bio: oferta, botones a sus redes y formulario con consentimiento.
- **Enlaces por red** (`?src=instagram|tiktok|whatsapp|web`, más `&campaign=...` opcional) para saber de dónde viene cada lead y qué convierte mejor.
- **Captura automática** vía webhooks de Meta:
  - DMs de Instagram → un lead por conversación.
  - Comentarios de Instagram con palabras clave («precio», «info»…) → lead con el @usuario.
  - Mensajes entrantes a WhatsApp Business (Cloud API) → lead con nombre y teléfono.
- **Panel/CRM**: resumen (leads por día, visitas y conversión por red), lista con filtros y búsqueda, estados (Nuevo → Contactado → Interesado → Cliente / Perdido), notas e historial, alta manual (p. ej. DMs de TikTok) y exportación a CSV.
- **Respuestas automáticas (bot)** en Instagram y WhatsApp (sección *Automatización*):
  - Reglas por palabra clave: comentario «precio» → DM privado con el enlace + respuesta pública; bienvenida al primer DM o WhatsApp.
  - Preguntas de cualificación una a una; las respuestas quedan en la ficha del lead.
  - Asistente con IA (Claude) que responde con la información del negocio cuando ninguna regla encaja. Requiere `ANTHROPIC_API_KEY`.
  - **Simulador** (*Probar bot*) para probarlo todo sin conectar Meta: ideal para enseñárselo a un cliente.
- **Seguimiento por WhatsApp** con un clic: abre `wa.me` con un mensaje personalizable (`{nombre}`, `{comercio}`, `{oferta}`), registra el contacto y pasa el lead a «Contactado».

Varios comercios pueden usar la misma instalación; cada uno solo ve sus leads.

## Publicar en un clic

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/marshsutido-tech/leadsocial)

Todo gratis: la app en Render (plan Free) y los datos en [Turso](https://turso.tech) (plan gratuito).

1. Crea una base de datos en Turso y copia su URL (`libsql://...`) y un token.
2. Pulsa el botón de arriba y pega esos dos valores en `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`.

En el plan Free, Render duerme la app tras 15 minutos sin visitas; la primera visita después tarda ~1 minuto en cargar.

## Puesta en marcha (local)

Requisitos: Node.js ≥ 20. Sin variables de Turso usa un archivo SQLite local en `./data/leads.db`.

```bash
npm install
cp .env.example .env   # rellena SESSION_SECRET
npm start              # http://localhost:3000
```

Crea una cuenta en `/registro`, completa **Ajustes** y copia los enlaces de **Enlaces** en las bios.

Tests: `npm test`.

## Conectar Instagram y WhatsApp (para que el bot envíe mensajes reales)

1. Crea una app en [Meta for Developers](https://developers.facebook.com/) con los productos *Instagram* (cuenta profesional) y *WhatsApp*.
2. Webhook: `https://TU_DOMINIO/webhooks/meta`, token de verificación = `META_VERIFY_TOKEN`. Pon el *App Secret* en `META_APP_SECRET` (se validan las firmas `X-Hub-Signature-256`).
3. Suscribe los campos `messages` y `comments` (Instagram) y `messages` (WhatsApp).
4. En **Automatización → Conexión con Meta** cada comercio guarda su *ID de cuenta de Instagram* + token (API de Instagram con inicio de sesión de Instagram, permisos `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`) y su *Phone Number ID* de WhatsApp + token.
5. Para usarlo con cuentas de otros comercios, la app de Meta debe pasar la revisión (*App Review*) de esos permisos.

TikTok no ofrece una API pública de DMs para comercios: se capta mediante el enlace de la bio (`?src=tiktok`) y el alta manual.

## Estructura

```
src/server.js        rutas (público, acceso, panel)
src/db.js            esquema y consultas (SQLite local o Turso)
src/auth.js          contraseñas (scrypt) y sesiones con cookie firmada
src/integrations.js  webhooks de Meta (Instagram + WhatsApp)
src/bot.js           motor de respuestas automáticas (reglas, preguntas, IA)
src/ai.js            asistente con IA (Claude)
src/meta.js          envío de mensajes con las APIs de Meta
src/views.js         HTML del servidor
public/style.css     estilos (claro/oscuro, adaptado a móvil)
```

## Siguientes pasos sugeridos

- Plantillas de WhatsApp para escribir a leads pasadas 24 h.
- Recordatorios de leads sin contactar (email o WhatsApp al comercio).
- Recuperación de contraseña y usuarios múltiples por comercio.
- Texto legal de privacidad (RGPD) en la página pública.
