// api/cron/pause-inactive-free.js
// Runs daily via Vercel Cron (configured in vercel.json).
// Marks free-plan accounts as 'inactive' if untouched for 30+ days.
// This is administrative only — it does NOT block sign-in or usage.
// If an inactive user logs back in, agent-chat.js and the dashboard gate
// both refresh last_active_at, and nothing here prevents them from using
// their account normally again.

export const config = { runtime: "edge" };

export default async function handler(req) {
  // Vercel Cron sends a special header; reject anything else to stop
  // random internet traffic from triggering this endpoint.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/users?plan=eq.free&subscription_status=eq.active&last_active_at=lt.${cutoff.toISOString()}`,
    {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ subscription_status: "inactive" }),
    }
  );

  const updated = await res.json().catch(() => []);
  return new Response(
    JSON.stringify({ paused_count: Array.isArray(updated) ? updated.length : 0 }),
    { headers: { "Content-Type": "application/json" } }
  );
}

