# Rentora API Server

Express API for **Rentora**, an equipment-rental marketplace for customers and local equipment owners.

- **Live URL:** Not deployed yet.
- **Local API:** `http://localhost:5000`
- **Database:** MongoDB via Mongoose models/indexes and MongoDB collection operations.

## Features

- JWT email/password authentication and Google ID-token sign-in; database-backed role authorization for renter, owner, and admin roles.
- One-time, hashed, 15-minute password reset links and authenticated password changes that revoke older sessions.
- Approved equipment search/filtering/sorting/pagination, owner inventory, admin review queue, favorites, and customer reviews.
- Server-priced booking requests with date-range inventory checks and paginated customer history.
- Stripe Checkout in test mode; signature-verified webhooks update booking/payment records idempotently.
- Admin and owner analytics, recurring booking completion job, SMTP completion notifications, and contact form storage.
- Idempotent demo data seeding for three roles, approved and pending equipment, and reviews.

## Data collections

| Collection | Main data |
| --- | --- |
| `users` | name, email, password hash or Google identity, role, image, phone, address, password-reset digest/expiry, token version |
| `equipment` | owner, title, description, category, price/rental type, quantity, availability, approval status, terms |
| `bookings` | customer/owner/equipment, rental dates and quantity, server-calculated total, payment and booking status |
| `payments` | booking, Stripe Checkout/payment-intent IDs, amount, currency, transaction status |
| `favorites` | customer and equipment pair |
| `reviews` | customer, equipment, optional booking, rating and comment |
| `contactMessages` | contact form message and handling status |

## API route groups

All API routes start with `/api`.

| Group | Routes |
| --- | --- |
| Health | `GET /health` |
| Authentication | `POST /auth/register`, `POST /auth/login`, `POST /auth/google`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/change-password` (authenticated), `GET/PATCH /auth/me`, `GET/POST /auth/logout` |
| Equipment | `GET /equipment`, `GET /equipment/:id`, `GET /equipment/my`, `POST /equipment`, `PATCH/DELETE /equipment/:id`, `PATCH /equipment/:id/approval` |
| Bookings | `POST /bookings`, `GET /bookings/availability`, `GET /bookings/my`, `GET /bookings/owner`, `GET /bookings/:id`, `PATCH /bookings/:id/cancel`, `PATCH /bookings/:id/status` |
| Payments | `POST /payments/checkout`, `POST /payments/webhook`, `GET /payments/verify/:bookingId`, `GET /payments/my` |
| Favorites and reviews | `GET /favorites`, `POST/DELETE /favorites/:equipmentId`, `GET/POST /reviews` |
| Admin | `/admin/overview`, `/admin/users`, `/admin/users/:id/role`, `/admin/equipment`, `/admin/bookings` |
| Owner | `GET /owner/analytics` |
| Contact | `POST /contact` |

The public equipment list supports `search` (name or location), `category`,
`rentalType`, `availability`, `minPrice`, `maxPrice`, `sort`, `page`, and
`limit`. Customer booking history supports `page` and `limit`.

## Local setup

Run each command in **Terminal: server**, with the working folder `rentora-server`.

```powershell
Copy-Item .env.example .env
npm install
npm run seed:demo
npm run dev
```

Set valid, private values in `.env` first. Required values include `MONGODB_URI`,
`JWT_SECRET`, `CLIENT_URL`, and `GOOGLE_CLIENT_ID`. `seed:demo` additionally
requires the three `SEED_*_EMAIL` and `SEED_*_PASSWORD` pairs. It creates:

- Admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
- Owner: `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`
- Customer: `SEED_CUSTOMER_EMAIL` / `SEED_CUSTOMER_PASSWORD`

The seed command never prints passwords or overwrites existing account passwords.
Use strong local-only credentials and do not commit `.env`.

For Stripe, configure a test-mode `STRIPE_SECRET_KEY` (`sk_test_...`) and the
webhook signing secret (`whsec_...`). The API rejects live-mode keys. Start the
Stripe CLI in **Terminal: server** (the server folder can be anywhere on `PATH`)
and forward events to the local webhook:

```powershell
stripe listen --forward-to localhost:5000/api/payments/webhook
```

Copy the signing secret printed by Stripe CLI into `STRIPE_WEBHOOK_SECRET`.
Enable `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, and
`checkout.session.async_payment_failed` for the deployed webhook endpoint. A
booking has one active checkout reservation; retries reuse the same Stripe
idempotency key until that session succeeds, expires, or fails.

### Render and Vercel payment configuration

For a test-mode deployment, set these backend variables in Render. Keep both
Stripe secrets private and never add them to Vercel or a `NEXT_PUBLIC_*` value.

| Render variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe test-mode secret key (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) for the matching test-mode webhook endpoint |
| `STRIPE_CURRENCY` | `bdt` (or another currency supported by the Stripe account) |
| `CLIENT_URL` | The deployed Vercel frontend origin, without a path or trailing slash |
| `CORS_ORIGIN` | Optional additional frontend origins, comma-separated |

In Stripe's test-mode Developers > Webhooks settings, register
`https://<your-render-host>/api/payments/webhook` and subscribe to the four
Checkout events listed above. Use that endpoint's signing secret in Render.
The Render manifest declares the Stripe secrets as unsynchronized environment
variables so they must be set privately in the Render dashboard.

In Vercel, set `NEXT_PUBLIC_API_URL` to
`https://<your-render-host>/api`, then rebuild the frontend. The success and
cancel redirects are derived from the backend `CLIENT_URL`. Keep Stripe in test
mode on both Stripe and Render; do not use a live secret key or real card.

Password reset email requires these backend environment variables:

| Variable | Value |
| --- | --- |
| `SMTP_HOST` | SMTP server hostname supplied by your email provider |
| `SMTP_PORT` | SMTP port (typically `587` for STARTTLS or `465` for implicit TLS) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password or provider-issued app password |
| `EMAIL_FROM` | Sender address authorized by your provider, e.g. `Rentora <noreply@example.com>` |
| `CLIENT_URL` | Frontend origin used to construct the reset link |

For local development, set these in `rentora-server/.env` and restart the API.
For production, add them as private environment secrets to the backend hosting
service (not the frontend's `NEXT_PUBLIC_*` settings), then redeploy/restart the
backend. Use credentials issued by your SMTP provider and verify that the
`EMAIL_FROM` sender is authorized there. The server logs configuration errors
and safe SMTP error codes without logging credentials or reset tokens.

Reset links use `CLIENT_URL`, expire after 15 minutes, and are single-use. The
same SMTP settings are used for rental completion notifications. The booking
completion job runs every five minutes by default; override with
`BOOKING_COMPLETION_CRON`.

The `users` collection gains reset-token digest/expiry fields and a token-version
field. These are stored on existing user documents; the server creates a sparse
index for reset-token lookup at startup. No manual data migration is required.

## Admin account

For a fresh local database, run `npm run seed:demo` using the server environment
above. The admin email/password are the values you set in `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`; no fixed credentials are embedded in the repository.

## Testing

The integration suite uses MongoDB and an isolated test database. Set
`MONGODB_URI`, `TEST_DB_NAME`, and any required test environment values in the
server `.env`, then run in **Terminal: server**, working folder `rentora-server`:

```powershell
npm test
```

The client application runs separately in **Terminal: client**, working folder
`rentora-client`, at `http://localhost:3000`. Configure its
`NEXT_PUBLIC_API_URL` to the server API.

## Packages

`express`, `mongoose`, `mongodb`, `bcryptjs`, `jsonwebtoken`, `jose`, `cors`,
`cookie-parser`, `stripe`, `node-cron`, `nodemailer`, and `dotenv`.
