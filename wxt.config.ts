import { defineConfig } from 'wxt';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const version = readFileSync(r('./VERSION'), 'utf8').trim();

// Chrome / Edge manifests take 1-4 numeric parts: a release x.y.z is
// x.y.z.1000, a prerelease x.y.z-beta.N is x.y.z.N (see common/scripts/release-lib.ps1).
function manifestVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]*?(\d+))?$/.exec(v);
  if (!m) throw new Error(`VERSION ${v} is not MAJOR.MINOR.PATCH[-pre.N]`);
  return `${m[1]}.${m[2]}.${m[3]}.${m[4] ?? '1000'}`;
}

export default defineConfig({
  srcDir: 'src',
  // WXT resolves publicDir against the project root, not srcDir
  publicDir: 'src/public',
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: {
    name: 'NyaPassword',
    description: '自建、端到端加密的密码管理器：自动填充、通行密钥、一次性密码。',
    version: manifestVersion(version),
    version_name: version,
    minimum_chrome_version: '120',
    // nativeMessaging ("unlock with the desktop app") must be a required
    // permission: Chrome binds runtime.connectNative only when the service
    // worker starts, so an optional permission granted later leaves it missing
    permissions: ['storage', 'unlimitedStorage', 'tabs', 'alarms', 'idle', 'offscreen', 'webNavigation', 'nativeMessaging'],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    commands: {
      'fill-login': { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' }, description: '填写当前网站的登录信息' },
    },
    web_accessible_resources: [{ resources: ['inline.html', 'prompt.html', 'chunks/*', 'assets/*'], matches: ['http://*/*', 'https://*/*'] }],
    action: { default_title: 'NyaPassword' },
  },
  vite: () => ({
    resolve: {
      alias: {
        $lib: r('../common/web/src/lib'),
        $components: r('../common/web/src/components'),
      },
    },
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: { fs: { allow: [r('..')] } },
  }),
  zip: { artifactTemplate: `NyaPassword-Chrome_${version}.zip` },
});
