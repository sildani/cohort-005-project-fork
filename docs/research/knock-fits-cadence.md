# How Knock fits Cadence's stack

Research for [#8](https://github.com/sildani/cohort-005-project-fork/issues/8), which is part of map [#7](https://github.com/sildani/cohort-005-project-fork/issues/7) (In-app Notifications with Knock). Researched 2026-11-12.

The sources are Knock's docs and pricing page, plus the SDK source on GitHub: `knocklabs/knock-node` at `main`, which ships `@knocklabs/node@1.41.1`, and `knocklabs/javascript` at `main`, which ships `@knocklabs/react@0.15.1`, `@knocklabs/react-core@0.17.1` and `@knocklabs/client@0.23.1`. Some claims are inferred or unconfirmed, and they are marked **(unconfirmed)** or **(inferred)**.

## TL;DR

| Question | Answer |
| --- | --- |
| Is the real-time feed on the free tier? | **Yes (inferred, strongly).** Real-time comes through Knock's managed websocket, which is part of the in-app feed. No Knock page restricts it to a plan. The Free plan includes in-app feeds, the Feed API and the prebuilt components. The Enterprise-only list does not include real-time. |
| What are the free tier's limits? | 10,000 messages a month. A message is one delivery to one user on one channel, and each in-app feed item counts. Environments are unlimited, there is 30-day log retention, and the Knock branding stays. **There is no hard cap.** If Cadence goes over, Knock contacts us to add billing. Nothing gets charged unless we add a billing method. |
| How does the server SDK handle failure? | The default timeout is **60s**. It retries **2** times (0.5s, then 1s, with jitter) on connection errors, 408, 409, 429 and 5xx. It sends an automatic `Idempotency-Key` that stays the same across its own retries. Every failure throws a subclass of `APIError`. **These defaults can hold a request open for about 3 minutes, so Cadence must set a short `timeout`, and should consider `maxRetries: 0`, then fire-and-forget or catch.** |
| How is the feed secured? | Without enhanced security, the public key alone can read **any** user's feed. Enhanced security mode adds a server-signed RS256 JWT (`sub` = user id) on top of the public key. Cadence signs it with `signUserToken()` from `@knocklabs/node` in the root loader. No source says it is paid-only. |
| Does the React package work with SSR? | **Yes, verified locally.** `renderToString` with `KnockProvider`, `KnockFeedProvider` and `NotificationIconButton` renders the bell without throwing. The socket only opens in the browser. The prebuilt pieces are the bell, the popover and the full-page feed. You can override cell rendering and restyle with CSS variables, or build your own UI with the headless hooks. |
| Can workflows be defined in code? | Yes. The Knock CLI pulls and pushes `.knock/workflows/<key>/workflow.json` and commits it to an environment, then the dashboard or CLI promotes it upward. The CLI and Management API are on Free. |
| How do we test it? | Mock the SDK in vitest. Knock gives no SDK mocking guidance. **The in-app channel does not support sandbox mode,** so any real trigger against a Knock environment, including development, uses up the 10k messages. |

## 1. Server SDK (`@knocklabs/node`)

- **Install and runtime.** Install with `npm install @knocklabs/node`. It requires "Node.js 20 LTS or later" and "TypeScript >= 4.9" ([README](https://github.com/knocklabs/knock-node#requirements)). Cadence is on `@types/node@22`, so it fits. The `jose` dependency is ESM-only, but Cadence is `"type": "module"`, so that is fine ([README](https://github.com/knocklabs/knock-node)).
- **Triggering a workflow.**

  ```ts
  const knock = new Knock({ apiKey: process.env.KNOCK_API_KEY });
  await knock.workflows.trigger("workflow-key", {
    recipients: [...],
    actor,
    data,
    tenant,
  });
  ```

  The call returns `{ workflow_run_id }` ([README](https://github.com/knocklabs/knock-node), [API ref](https://docs.knock.app/api-reference/workflows/trigger)). "All workflow runs are executed asynchronously", so a 200 only means Knock accepted the trigger, not that anything was delivered. The trigger endpoint is in rate-limit **tier 5**.
- **Identifying users.** Call `knock.users.update(userId, { name, email, ... })`, which is `PUT /v1/users/{user_id}`. It upserts and deep-merges properties, and is in rate-limit tier 3 ([API ref](https://docs.knock.app/api-reference/users/update), [source](https://github.com/knocklabs/knock-node/blob/main/src/resources/users/users.ts)).
- **Inline identification.** A trigger can identify the recipients, actor and tenant inline. "Inline identification requires user objects (even if they only contain an `id` property), not ID strings". This "enables lazy recipient creation" ([docs](https://docs.knock.app/managing-recipients/identifying-recipients)). **(Unconfirmed)** The docs don't say what happens when you trigger for a bare string id that was never identified.
- **Idempotency.**
  - Knock honours an `Idempotency-Key` header (max 255 chars) on `POST /workflows/:key/trigger` only. It caches the response for 24h and replays it with `idempotent-replayed: true`. A replay with different params is an error. Only 2xx responses are cached ([docs](https://docs.knock.app/api-reference/overview/idempotent-requests)).
  - The SDK sends a key on every non-GET request automatically, generated as `stainless-node-retry-<uuid>`, and reuses it across its own retries. You can pass a stable key per call with `{ idempotencyKey }` in the request options ([client.ts L370, L797-800](https://github.com/knocklabs/knock-node/blob/main/src/client.ts), [request-options.ts](https://github.com/knocklabs/knock-node/blob/main/src/internal/request-options.ts)).
  - For Cadence, a domain-derived key such as `lesson-comment-<id>-reply` makes our own re-sends safe as well.
- **Timeouts.** The default is `DEFAULT_TIMEOUT = 60000` ms. Configure it per client or per request with `timeout`. A timeout throws `APIConnectionTimeoutError` ([client.ts L290, L884](https://github.com/knocklabs/knock-node/blob/main/src/client.ts)).
- **Retries.**
  - `maxRetries` defaults to 2. The SDK retries on connection errors and timeouts, and on 408, 409, 429 and ≥500. It obeys an `x-should-retry` response header.
  - Backoff is `min(0.5 × 2^n, 8)` seconds with up to 25% jitter. It honours `retry-after` ([client.ts `shouldRetry`, `calculateDefaultRetryTimeoutMillis`](https://github.com/knocklabs/knock-node/blob/main/src/client.ts), [README "Retries"](https://github.com/knocklabs/knock-node#retries)).
- **Errors.** Every failure throws a subclass of `APIError`:

  | Error | Status |
  | --- | --- |
  | `BadRequestError` | 400 |
  | `AuthenticationError` | 401 |
  | `PermissionDeniedError` | 403 |
  | `NotFoundError` | 404 |
  | `UnprocessableEntityError` | 422 |
  | `RateLimitError` | 429 |
  | `InternalServerError` | ≥500 |
  | `APIConnectionError` and `APIConnectionTimeoutError` | none |

  Source: [README](https://github.com/knocklabs/knock-node#handling-errors).
- **What this means for "a Notification must never block or roll back its cause."**
  - If Knock is unreachable, the defaults make a single `trigger` take up to 3 × 60s plus backoff before it throws.
  - So Cadence should configure the client with a short `timeout`, around 2–5s, and decide on `maxRetries`.
  - It should call `trigger` **after** the domain write commits, outside the DB transaction, and wrap it in `try/catch` that logs.
  - Or it can call `trigger` without awaiting it. Because Node keeps running after the response, a floating promise with a `.catch` works on a long-lived server like `react-router-serve`.
  - There is no built-in outbox or queue. Durable retry beyond the SDK's would be ours to build. **(Inferred.)**

## 2. Mapping Cadence people to Knock users

- **Ids.** Knock ids are strings of at most 256 chars, with no `/` or `#`, and they **can never change**. The docs say to "use your internal identifier", meaning a primary key, not email. They suggest prefixes for different user types ([docs](https://docs.knock.app/concepts/users)).
- **Cadence's id.** `users.id` is an autoincrement integer (`app/db/schema.ts`). The Knock id would be `String(user.id)`, or a prefixed form such as `user_42`.
- **Seeding.** Reseeding the SQLite DB reuses the ids 1..N for possibly different people. Separate Knock environments, or an environment-specific prefix, keep dev data from colliding. **(Inferred.)**
- **When to identify.** There are two documented options ([docs](https://docs.knock.app/managing-recipients/identifying-recipients)):
  - Call `users.update` when a user signs up or when their name or email changes.
  - Identify inline on every trigger by passing recipient objects such as `{ id, name, email }`.

  For in-app only, inline identification on trigger is the simplest choice. It needs no extra calls on signup, and the feed only needs a user to exist once they have a message.
- **The React side also identifies.** `KnockProvider`'s `identificationStrategy` defaults to `"inline"`, so passing `user={{ id, name, ... }}` upserts the user from the browser. Pass `"skip"` to stop it ([client knock.ts L116-166](https://github.com/knocklabs/javascript/blob/main/packages/client/src/knock.ts)).
- **Switching users in the DevUI.**
  - The DevUI switch posts to `/api/switch-user`, which sets the session cookie and redirects. The root loader then returns a different current user.
  - If the root loader passes `user={{ id }}` and a freshly signed `userToken` to `KnockProvider`, `useAuthenticatedKnockClient` notices the change. It re-authenticates in place, or tears the client down and builds a new one. The feed subtree remounts and refetches because its provider key includes the userId ([useAuthenticatedKnockClient.ts](https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/hooks/useAuthenticatedKnockClient.ts)).
  - With no user selected, pass `enabled={false}`, or skip the provider. The client then stays idle, with "no requests, no websocket" ([interfaces.ts](https://github.com/knocklabs/javascript/blob/main/packages/client/src/interfaces.ts)).

## 3. React in-app feed (`@knocklabs/react`)

- **Peer dependencies.** It supports React 17–19. `next` and `@tanstack/react-router` are *optional* peers, and neither is needed ([package.json](https://github.com/knocklabs/javascript/blob/main/packages/react/package.json)).
- **Setup.** Import `@knocklabs/react/dist/index.css`, then wrap the UI:

  ```tsx
  <KnockProvider apiKey={...} user={{ id }} userToken={...}>
    <KnockFeedProvider feedId={channelId}>
      {/* feed components */}
    </KnockFeedProvider>
  </KnockProvider>
  ```

  Source: [docs](https://docs.knock.app/in-app-ui/react/feed).
- **Prebuilt components.** `NotificationIconButton` is the bell, with a badge that counts unseen items by default or unread items with `badgeCountType="unread"`. There is also `NotificationFeedPopover`, `NotificationFeed` (the full-page feed), `NotificationCell`, `UnseenBadge` and `EmptyFeed` ([docs](https://docs.knock.app/in-app-ui/react/overview), [source](https://github.com/knocklabs/javascript/tree/main/packages/react/src/modules/feed/components)).
- **Customisation.**
  - Replace cells with `renderItem`, and add `children` or `avatar` to `NotificationCell`.
  - Restyle with CSS variables (`--rnf-*`) or the `rnf-` classes. `colorMode="dark"` switches to the dark theme.
  - For fully custom UI, use the headless hooks such as `useKnockFeed`, `useNotifications` and `useNotificationStore` ([docs](https://docs.knock.app/in-app-ui/react/feed), [useNotifications](https://docs.knock.app/in-app-ui/react/sdk/hooks/use-notifications)).
  - With Tailwind and shadcn, Cadence can either restyle the prebuilt pieces or use the hooks with its own Radix popover.
- **Read, seen and archived.** Items have `seen_at`, `read_at` and `archived_at`. The feed client has `markAsSeen`, `markAsRead` and `markAsArchived`, plus `markAllAs*` versions of each ([feed.ts](https://github.com/knocklabs/javascript/blob/main/packages/client/src/clients/feed/feed.ts)). The popover marks items as seen when it opens. Override that with `onOpen` to mark them read. Filter the feed with `initialFilterStatus`.
- **SSR with React Router.**
  - React Router doesn't use `"use client"`. The library guards its browser APIs: the socket is only created when `typeof window !== "undefined" && typeof WebSocket !== "undefined"`, and `document` and `window` access is also guarded ([client api.ts L129](https://github.com/knocklabs/javascript/blob/main/packages/client/src/api.ts)).
  - **Verified locally.** In Node 22, `renderToString` with `KnockProvider`, `KnockFeedProvider` and `NotificationIconButton` (using `@knocklabs/react@0.15.1`) rendered the bell button's HTML without throwing. It logged only a warning about the fake `feedId`.
  - The server renders an empty or zero-badge bell, and the feed loads after hydration. **(Inferred.)** If a hydration mismatch appears on the badge, render it client-only.
  - **(Unconfirmed)** I didn't test this through Vite's SSR transform. If the CSS import or the CJS/ESM resolution complains, add `ssr.noExternal: ['@knocklabs/react']` in `vite.config.ts`.

## 4. Real-time and the free tier

- **How it works.**
  - "The Knock in-app real-time service is a managed service that provides a websocket connection to your application" ([socket behavior](https://docs.knock.app/in-app-ui/feeds/socket-behavior)).
  - Under the hood it is a Phoenix channels socket (`phoenix@1.8.9`) at `wss://…/ws/v1`, reached through a signed connect-URL gateway ([client api.ts](https://github.com/knocklabs/javascript/blob/main/packages/client/src/api.ts), [package.json](https://github.com/knocklabs/javascript/blob/main/packages/client/package.json)).
  - The SDK handles reconnection itself. `auto_manage_socket_connection` disconnects inactive tabs after `auto_manage_socket_connection_delay`, which defaults to 2000ms, and reconnects when the tab comes back ([feed docs](https://docs.knock.app/in-app-ui/react/feed)).
  - Knock describes it as "A managed socket delivers real-time messages across in-app guides, inboxes, feeds, and toasts, without polling" ([in-app product page](https://knock.app/channels/in-app-notifications)).
- **Is it on Free?**
  - No Knock page restricts the socket to a plan.
  - The [pricing page](https://knock.app/pricing) lists "In-app feeds", "Feed API", "Pre-built components" and "Manage via API & CLI" as **Yes** on Free.
  - [Plans](https://docs.knock.app/manage-your-account/knock-plans) says "Most features are available across all three plans". Its Enterprise-only list covers per-tenant preferences and branding, i18n, SAML and SCIM, custom roles, warehouse export, analytics extensions and batch render above 10. Real-time is not on it.
  - **Conclusion: real-time is on Free (inferred from the absence of any restriction, not from an explicit "real-time: Free ✓" row).**
  - **(Unconfirmed)** I found no published limits on websocket connections.
- **Free plan limits** ([pricing](https://knock.app/pricing), [plans](https://docs.knock.app/manage-your-account/knock-plans)):
  - **10,000 messages a month.** "A message is counted each time a notification is successfully delivered to a single user on a single channel." Usage "may be accrued in any Knock environment", so development counts as well. Bounced or failed messages don't count.
  - 500 guide recipients and 500 agent credits, which Cadence doesn't need.
  - Unlimited environments, unlimited feed retention, and 30-day log retention.
  - Knock branding cannot be removed.
- **What triggers a charge.** "We don't hard cap your messages." If you exceed the limit, Knock contacts you to add billing ([pricing](https://knock.app/pricing)). With no card on file, nothing is charged automatically. **(Inferred.)** The Starter plan is $250 a month for 50k messages, then $0.005 each.
- **Rate limits.** Limits are tiered. The values listed are 1, 5, 60, 200 and 1,000 requests per second, and the docs don't say which tier each endpoint belongs to. Limits are scoped per environment for API keys, and per environment and user for signed user tokens. Exceeding them returns a 429, which the SDK retries ([docs](https://docs.knock.app/api-reference/overview/rate-limits)). The docs list no per-plan differences.
- **Budget arithmetic for Cadence.** A fan-out to many recipients counts one message per recipient. For example, a course announcement to 500 students counts as 500 messages. Fan-outs are the main way Cadence could exceed 10k.

## 5. Securing the feed

- **Without enhanced security.** With it disabled, Knock accepts public-key requests without a token. **The public key alone can act as any user**, so anyone could read anyone's feed by changing the user id ([docs](https://docs.knock.app/in-app-ui/security-and-authentication)).
- **With enhanced security mode** (an environment setting in the dashboard):
  - Clients send the public key **and** a signed user token, a JWT "signed against your private signing key using an RS256 algorithm".
  - `sub` (the user id) is required. `iat` and `exp` are recommended.
  - Generate the signing key under Platform > API keys, in base64 or PEM format. By convention it lives in `KNOCK_SIGNING_KEY`.
- **Server side.**
  - Sign with `signUserToken(String(user.id), { expiresInSeconds })` from `@knocklabs/node`. It reads `KNOCK_SIGNING_KEY` by default and defaults to 3600s expiry ([tokenSigner.ts](https://github.com/knocklabs/knock-node/blob/main/src/lib/tokenSigner.ts)).
  - In Cadence, the root or app-layout loader signs a token for the session user on each request and passes it with the public key to `KnockProvider` as `userToken`.
  - Long-lived tabs can refresh the token with `onUserTokenExpiring` and `timeBeforeExpirationInMs` on `KnockProvider`. That needs a small resource route that returns a new token ([KnockProvider.tsx](https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/context/KnockProvider.tsx)).
- **Keys.** The secret API key (`sk_…`) and the signing key stay on the server. Only the public key and the user token reach the browser.
- **Plan.** No source lists enhanced security as paid or Enterprise-only, and it is not on the Enterprise-only list. **(Inferred: available on Free.)**

## 6. Workflows in code and environments

- **The Knock CLI.**
  - Install with `npm i -g @knocklabs/cli` or Homebrew. Authenticate with `knock login` locally, or with `--service-token` in CI ([CLI overview](https://docs.knock.app/cli/overview)).
  - `knock.json` sets the `knockDir`. Resources live under `.knock/workflows/<key>/workflow.json`.
  - `knock workflow pull` and `knock workflow push [--all] [--commit -m ...] [--environment] [--branch]` move workflows in and out. A push creates the workflow or updates it by key ([push](https://docs.knock.app/cli/workflow/push)).
  - The Management API exposes the same operations. "Manage via API & CLI" is Yes on Free ([pricing](https://knock.app/pricing)).
- **Versioning across environments.**
  - Content is versioned with commits and "promoted upwards through environments", for example development to production. Each environment has its own API keys and isolated data: users, messages and logs are never copied between them ([environments](https://docs.knock.app/concepts/environments)).
  - By default, "Modify resources in any environment" is on. Turn it off to make every environment except development read-only, which forces the build-in-dev, promote-to-prod workflow.
  - Free allows unlimited environments.
- **Recommendation.** Commit the `.knock/` directory to the repo, push and commit it to development, and promote it to production. The dashboard stays available for previewing templates.

## 7. Local dev and tests

- **Local development.** Point it at Knock's **development** environment with that environment's `KNOCK_API_KEY`, public key, signing key and feed channel id. There is no local Knock emulator. **(Unconfirmed: none found.)**
- **Sandbox mode.** `settings.sandbox_mode` and `settings.skip_delay` exist for triggers, and the dashboard test runner exists as well ([testing workflows](https://docs.knock.app/send-notifications/testing-workflows)). **But "the in-app channel doesn't support sandbox mode"** ([plans](https://docs.knock.app/manage-your-account/knock-plans)). Every in-app message from dev, CI or a test run against a real environment counts toward the 10k.
- **vitest.** Knock publishes no guidance on mocking the SDK. What I recommend, which is **my recommendation, not Knock's**:
  - Put Knock behind a thin Cadence module, for example `app/lib/notifications.server.ts`, that exposes domain-level functions such as `notifyX(...)`.
  - In tests, `vi.mock` that module or inject a fake client, then assert on the workflow key, recipients and data.
  - Add one test that makes the fake `trigger` reject or hang, to prove the causing action still succeeds. This is the never-block rule.
  - Don't hit Knock from the test suite.

## Surprises that affect other tickets

1. **The SDK defaults are hostile to "never block".** The defaults are a 60s timeout and 2 retries, which can block a request for about 3 minutes. Cadence must override `timeout` and `maxRetries` and trigger outside transactions.
2. **Without enhanced security mode, the feed is not private.** Turn it on in every environment that matters. That requires signing tokens in a loader.
3. **There's no sandbox for in-app, and dev usage counts.** Tests must mock Knock, and manual dev testing uses up the same 10k a month.
4. **Fan-out counts once per recipient.** "Notify every Student in a course" can use up the free tier fast. There is no hard cap, but Knock would ask us to start paying.
5. **Real-time on Free is inferred, not stated.** Nothing restricts it to a plan, but no page says "real-time ✓ Free" outright.
6. **Ids are permanent and environments are isolated.** Reseeding the SQLite DB reuses the integer ids, so use a dedicated Knock dev environment, which costs nothing on Free.
