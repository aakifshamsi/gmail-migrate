module.exports = async function handler(req, res) {
  const workerUrl = process.env.WORKER_URL;

  if (!workerUrl) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Missing WORKER_URL env var in Vercel project settings.');
    return;
  }

  const base = workerUrl.replace(/\/$/, '');
  const target = base + (req.url || '/');
  res.statusCode = 307;
  res.setHeader('Location', target);
  res.end();
};
