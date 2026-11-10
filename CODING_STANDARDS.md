# Coding standards

## Fail with a thrown response, not a return value

A loader or an action that cannot continue throws. It does not return an
error shape for the component to unpack.

```ts
if (!course) throw data("Course not found", { status: 404 });
```

The route then has one success path. A returned error shape gives every
component a second path to forget about.

## Below the route, return the refusal and let the route throw

A module that can turn a request down because of the data, such as a Refund
Request that was already decided, returns a result. It does not throw an HTTP
response. The route turns the refusal into a thrown response.

```ts
const raised = raiseRefundRequest(db, { purchaseId, reason });
if (!raised.ok) throw data("You have already asked for a refund.", { status: 409 });
```

The module stays free of HTTP, and the type checker makes the route handle
the refusal before it can read `raised.refundRequest`. Missing data the
caller should have ruled out first, such as an unknown id, is a bug: throw a
plain `Error`.

## Database modules take `db` as a parameter

A module that reads or writes the database takes `db: Db` as its first
argument. It does not import the shared `db` from `~/db`.

```ts
export function findRefundRequestForPurchase(db: Db, purchaseId: number) { … }
```

Routes pass the shared `db`. Tests pass a fresh in-memory one from
`createTestDb()` in `app/db/test-db.ts`, so each test runs against the real
schema with its own data and nothing to mock.

## Parse untrusted input with a schema

Form data, search parameters and request bodies get a zod schema before the
values reach any query. Do not read `formData.get("x") as string`. The cast
is a lie the type checker believes.

## Do not write `any`, and do not write `!`

Both switch the type checker off at the exact point you are least sure. If a
value can be missing, narrow it with a check. If you cannot name the type,
the shape is wrong — fix the shape.
