// functions/upload.js
export async function onRequest(context) {
  const { request, env } = context;

  // Check login
  const cookie = request.headers.get('Cookie') || '';
  if (!cookie.includes('family_session=1')) {
    return new Response('Unauthorized', { status: 401 });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const form = await request.formData();
  const file = form.get('file');

  if (!file) return new Response('No file uploaded', { status: 400 });

  const filename = `${Date.now()}-${file.name}`;
  await env.FAMILY_BUCKET.put(filename, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return new Response('Uploaded', { status: 200 });
}
