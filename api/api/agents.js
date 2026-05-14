// api/agents.js
// Create, read, update, delete agents — stored in Supabase

export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return json({ error: 'Unauthorized' }, 401);

  // Verify user
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return json({ error: 'Invalid token' }, 401);
  const user = await userRes.json();

  const url = new URL(req.url);
  const agentId = url.searchParams.get('id');

  // GET — list all agents for this user
  if (req.method === 'GET') {
    const res = await supabase(
      `agents?user_id=eq.${user.id}&order=created_at.desc`,
      'GET', null, process.env.SUPABASE_SERVICE_KEY
    );
    return json(await res.json());
  }

  // POST — create new agent
  if (req.method === 'POST') {
    const body = await req.json();
    const agent = {
      id:            crypto.randomUUID(),
      user_id:       user.id,
      name:          body.name,
      emoji:         body.emoji || '🤖',
      description:   body.description || '',
      system_prompt: body.system_prompt || 'You are a helpful assistant.',
      model:         body.model || 'claude-sonnet-4-20250514',
      is_live:       true,
      created_at:    new Date().toISOString(),
    };
    const res = await supabase('agents', 'POST', agent, process.env.SUPABASE_SERVICE_KEY);
    return json(await res.json(), 201);
  }

  // PUT — update agent
  if (req.method === 'PUT' && agentId) {
    const body = await req.json();
    const res = await supabase(
      `agents?id=eq.${agentId}&user_id=eq.${user.id}`,
      'PATCH', body, process.env.SUPABASE_SERVICE_KEY
    );
    return json(await res.json());
  }

  // DELETE — remove agent
  if (req.method === 'DELETE' && agentId) {
    await supabase(
      `agents?id=eq.${agentId}&user_id=eq.${user.id}`,
      'DELETE', null, process.env.SUPABASE_SERVICE_KEY
    );
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}

function supabase(path, method, body, key) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Prefer':        'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

