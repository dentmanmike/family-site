// functions/auth.js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const cookieHeader = request.headers.get('Cookie') || '';
  const loggedIn = cookieHeader.includes('family_session=1');

  // Logout
  if (url.searchParams.get('logout')) {
    return new Response('Logged out', {
      status: 200,
      headers: {
        'Set-Cookie': 'family_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      },
    });
  }

  // Check session
  if (request.method === 'GET') {
    if (loggedIn) return new Response('OK', { status: 200 });
    return new Response('Not logged in', { status: 401 });
  }

  // Handle login
  if (request.method === 'POST') {
    const form = await request.formData();
    const user = form.get('username');
    const pass = form.get('password');

    if (user === env.FAMILY_USER && pass === env.FAMILY_PASS) {
      return new Response('OK', {
        status: 200,
        headers: {
          'Set-Cookie': 'family_session=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800', // 7 days
        },
      });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  return new Response('Method not allowed', { status: 405 });
}
