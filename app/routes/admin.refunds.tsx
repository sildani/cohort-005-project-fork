import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  checkRefundEligibility,
  daysLeftInWindow,
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  REFUND_WINDOW_DAYS,
  type RefundIneligibleReason,
} from "~/lib/refund-eligibility";
import { getRefundEligibilityFacts } from "~/lib/refund-facts.server";
import {
  approveRefundRequest,
  declineRefundRequest,
} from "~/lib/refund-decisions.server";
import {
  buildRefundApprovedEmail,
  buildRefundDeclinedEmail,
  DECLINE_IS_FINAL,
} from "~/lib/refund-emails";
import { RefundStatusBadge } from "~/components/refund-status-badge";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const VIEWS = [
  { status: RefundStatus.Open, label: "Open" },
  { status: RefundStatus.Approved, label: "Approved" },
  { status: RefundStatus.Declined, label: "Declined" },
] as const;

const viewSchema = z
  .enum([RefundStatus.Open, RefundStatus.Approved, RefundStatus.Declined])
  .catch(RefundStatus.Open);

const declineReasonSchema = z
  .string()
  .trim()
  .min(10, "Give the learner a little more explanation.")
  .max(1000, "Please keep the Decline Reason under 1000 characters.");

const adminRefundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: declineReasonSchema,
  }),
]);

// What changed since the learner asked, worded for the Admin.
const STALE_MESSAGES: Record<RefundIneligibleReason, string> = {
  "window-closed": `Now past the ${REFUND_WINDOW_DAYS}-day window`,
  "watched-too-much": `Has since watched ${REFUND_WATCH_LIMIT_SECONDS / 3600}+ hours`,
  "completed-too-much": `Has since completed ${REFUND_COMPLETION_LIMIT * 100}%+ of lessons`,
};

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to decide refunds.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", { status: 403 });
  }

  return currentUser;
}

const learners = alias(users, "learner");
const deciders = alias(users, "decider");

function listRefundRequests(status: RefundStatus) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      amountRefunded: refunds.amountRefunded,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      deciderName: deciders.name,
      learnerId: learners.id,
      learnerName: learners.name,
      learnerEmail: learners.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(learners, eq(purchases.userId, learners.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(deciders, eq(refunds.resolvedByUserId, deciders.id))
    .where(eq(refunds.status, status))
    .orderBy(
      status === RefundStatus.Open
        ? asc(refunds.requestedAt)
        : desc(refunds.resolvedAt)
    )
    .all();
}

function countByStatus() {
  const counts = { open: 0, approved: 0, declined: 0 } as Record<
    RefundStatus,
    number
  >;
  const rows = db
    .select({ status: refunds.status, count: sql<number>`count(*)` })
    .from(refunds)
    .groupBy(refunds.status)
    .all();
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  const view = viewSchema.parse(new URL(request.url).searchParams.get("view"));
  const today = new Date();

  const refundRequests = listRefundRequests(view).map((row) => {
    if (row.status !== RefundStatus.Open) {
      return { ...row, evidence: null };
    }

    const facts = getRefundEligibilityFacts(db, {
      userId: row.learnerId,
      courseId: row.courseId,
      purchasedAt: row.purchasedAt,
      today,
    });
    const eligibility = checkRefundEligibility(facts);

    return {
      ...row,
      evidence: {
        daysLeft: daysLeftInWindow(row.purchasedAt, today),
        hoursWatched: facts.secondsWatched / 3600,
        percentCompleted:
          facts.totalLessons === 0
            ? 0
            : Math.round((facts.completedLessons / facts.totalLessons) * 100),
        staleBecause: eligibility.eligible
          ? null
          : STALE_MESSAGES[eligibility.reason],
      },
    };
  });

  return { view, counts: countByStatus(), refundRequests };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, adminRefundActionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const decision = parsed.data;
  const result =
    decision.intent === "approve"
      ? approveRefundRequest(db, {
          refundRequestId: decision.refundRequestId,
          adminUserId: admin.id,
        })
      : declineRefundRequest(db, {
          refundRequestId: decision.refundRequestId,
          adminUserId: admin.id,
          declineReason: decision.declineReason,
        });

  if (!result.ok) {
    const { status, byName } = result.alreadyDecided;
    return data(
      { error: `Already ${status} by ${byName ?? "another Admin"}.` },
      { status: 409 }
    );
  }

  const details = db
    .select({
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(purchases.id, result.refundRequest.purchaseId))
    .get();

  if (details) {
    const email =
      decision.intent === "approve"
        ? buildRefundApprovedEmail({
            ...details,
            amount: result.refundRequest.amountRefunded ?? 0,
          })
        : buildRefundDeclinedEmail({
            ...details,
            declineReason: decision.declineReason,
          });
    console.log(
      `[email] to=${email.to} subject=${email.subject}\n${email.body}`
    );
  }

  return {
    success: true,
    message:
      decision.intent === "approve"
        ? "Refund Request approved."
        : "Refund Request declined.",
  };
}

type RefundRequestRow = Route.ComponentProps["loaderData"]["refundRequests"][number];

function useDecisionFetcher() {
  const fetcher = useFetcher<{ success?: boolean; message?: string; error?: string }>();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.success && fetcher.data.message) {
      toast.success(fetcher.data.message);
    }
    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return fetcher;
}

function describeWindow(daysLeft: number) {
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === 1) return "1 day left";
  if (daysLeft === 0) return "Last day today";
  return `Closed ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

type Step = "idle" | "approve" | "decline-write" | "decline-confirm";

function OpenRefundRequest({ refundRequest }: { refundRequest: RefundRequestRow }) {
  const fetcher = useDecisionFetcher();
  const [step, setStep] = useState<Step>("idle");
  const [declineReason, setDeclineReason] = useState("");
  const busy = fetcher.state !== "idle";
  const evidence = refundRequest.evidence;
  const trimmedReason = declineReason.trim();
  const reasonError = declineReasonSchema.safeParse(declineReason).error
    ?.issues[0]?.message;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.error) setStep("idle");
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{refundRequest.learnerName}</p>
            <p className="text-sm text-muted-foreground">
              {refundRequest.learnerEmail} ·{" "}
              <Link
                to={`/courses/${refundRequest.courseSlug}`}
                className="hover:underline"
              >
                {refundRequest.courseTitle}
              </Link>
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            Asked {new Date(refundRequest.requestedAt).toLocaleDateString()}
          </p>
        </div>

        {evidence?.staleBecause && (
          <div className="flex items-center gap-2 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              {evidence.staleBecause}. They were eligible when they asked; you
              can still approve or decline.
            </span>
          </div>
        )}

        {evidence && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Evidence label="Paid" value={formatPrice(refundRequest.amountPaid)} />
            <Evidence
              label="Bought"
              value={new Date(refundRequest.purchasedAt).toLocaleDateString()}
            />
            <Evidence label="Window" value={describeWindow(evidence.daysLeft)} />
            <Evidence
              label="Watched"
              value={`${evidence.hoursWatched.toFixed(1)} h`}
            />
            <Evidence
              label="Lessons done"
              value={`${evidence.percentCompleted}%`}
            />
          </dl>
        )}

        <blockquote className="whitespace-pre-line border-l-2 pl-3 text-sm">
          {refundRequest.reason}
        </blockquote>

        {step === "idle" && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setStep("approve")} disabled={busy}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStep("decline-write")}
              disabled={busy}
            >
              Decline
            </Button>
          </div>
        )}

        {step === "approve" && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">
              Refund {formatPrice(refundRequest.amountPaid)} and remove{" "}
              {refundRequest.learnerName}'s access?
            </p>
            <p className="text-xs text-muted-foreground">
              Their progress and watch history are kept. This decision is final.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  fetcher.submit(
                    { intent: "approve", refundRequestId: String(refundRequest.id) },
                    { method: "post" }
                  )
                }
              >
                {busy ? "Approving..." : "Approve refund"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStep("idle")}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "decline-write" && (
          <div className="space-y-3 rounded-md border p-3">
            <label
              htmlFor={`decline-reason-${refundRequest.id}`}
              className="text-sm font-medium"
            >
              Decline Reason (the learner will read this)
            </label>
            <Textarea
              id={`decline-reason-${refundRequest.id}`}
              rows={3}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="Why can't we refund this purchase?"
            />
            {declineReason.length > 0 && reasonError && (
              <p className="text-xs text-muted-foreground">{reasonError}</p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={Boolean(reasonError)}
                onClick={() => setStep("decline-confirm")}
              >
                Review
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStep("idle")}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "decline-confirm" && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">
              {refundRequest.learnerName} will read:
            </p>
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="whitespace-pre-line">{trimmedReason}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {DECLINE_IS_FINAL}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  fetcher.submit(
                    {
                      intent: "decline",
                      refundRequestId: String(refundRequest.id),
                      declineReason: trimmedReason,
                    },
                    { method: "post" }
                  )
                }
              >
                {busy ? "Declining..." : "Decline refund"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setStep("decline-write")}
              >
                Edit
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecidedRefundRequest({ refundRequest }: { refundRequest: RefundRequestRow }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{refundRequest.learnerName}</p>
            <p className="text-sm text-muted-foreground">
              {refundRequest.courseTitle} · paid{" "}
              {formatPrice(refundRequest.amountPaid)}
            </p>
          </div>
          <RefundStatusBadge status={refundRequest.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Decided by {refundRequest.deciderName ?? "an Admin"}
          {refundRequest.resolvedAt &&
            ` on ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`}
          {refundRequest.status === RefundStatus.Approved &&
            ` · refunded ${formatPrice(refundRequest.amountRefunded)}`}
        </p>
        <blockquote className="whitespace-pre-line border-l-2 pl-3 text-sm">
          {refundRequest.reason}
        </blockquote>
        {refundRequest.declineReason && (
          <p className="whitespace-pre-line rounded-md bg-muted p-3 text-sm">
            {refundRequest.declineReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { view, counts, refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline what learners have asked for. Decisions are final.
        </p>
      </div>

      <div className="mb-6 flex gap-2" role="tablist">
        {VIEWS.map(({ status, label }) => (
          <Link
            key={status}
            to={status === RefundStatus.Open ? "?" : `?view=${status}`}
            role="tab"
            aria-selected={view === status}
          >
            <Button size="sm" variant={view === status ? "default" : "outline"}>
              {label} ({counts[status]})
            </Button>
          </Link>
        ))}
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              {view === RefundStatus.Open
                ? "No Open Refund Requests. Nothing to decide."
                : `No ${view} Refund Requests yet.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) =>
            refundRequest.status === RefundStatus.Open ? (
              <OpenRefundRequest key={refundRequest.id} refundRequest={refundRequest} />
            ) : (
              <DecidedRefundRequest key={refundRequest.id} refundRequest={refundRequest} />
            )
          )}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
