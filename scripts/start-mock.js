process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
const requestedHost = process.env.HOST || '127.0.0.1';
if (!process.env.ADMIN_PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(requestedHost)) {
  throw new Error('Mock 默认密码只能用于本机监听；公开监听时请显式设置 ADMIN_PASSWORD');
}
process.env.ADMIN_PASSWORD ||= 'local-demo-admin-2026';

const [{ server }, { config }] = await Promise.all([
  import('../server.js'),
  import('../lib/config.js')
]);

server.listen(config.port, config.host, () => {
  console.log(`Memory Agent Studio (mock): http://${config.host}:${config.port}${config.basePath || '/'}`);
});
