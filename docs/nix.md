# Nix package and NixOS module

The flake exports `packages.<system>.default` and `packages.<system>.agora` for
Apple Silicon macOS and x86_64/aarch64 Linux, plus `nixosModules.default` and
`nixosModules.agora`. The standalone expressions in `nix/` remain importable.

## Build and run

From this checkout:

```sh
nix build .
HERMES_ENDPOINT=https://hermes.example.com nix run .
```

Use `github:victorjacobs/agora` instead of `.` to build or run without cloning.
For direct use with Nixpkgs available as `<nixpkgs>`:

```sh
nix-build --expr 'let pkgs = import <nixpkgs> {}; in pkgs.callPackage ./nix/package.nix {}'
HERMES_ENDPOINT=https://hermes.example.com ./result/bin/agora
```

Open `http://127.0.0.1:5173/`. Set `AGORA_PORT` to choose another port.
The executable includes Node.js 24, the built UI, and production dependencies;
it runs independently of your working directory. Configure the endpoint with
environment variables, rather than a local `.env.local` file.

The package builds and checks the UI from the committed npm lockfile. Local
environment files, dependencies, and build artifacts are excluded from its
source. To select a Hermes profile when building:

```nix
agora.packages.${pkgs.stdenv.hostPlatform.system}.default.override { hermesProfile = "work"; }
```

Alternatively, use `pkgs.callPackage ./nix/package.nix { hermesProfile = "work"; }`.

## NixOS

Add `agora.nixosModules.default` to the system's modules when using a flake input,
as shown in the [README](../README.md#nix-package-and-nixos). A direct import also works:

```nix
{
  imports = [ /path/to/agora/nix/module.nix ];

  services.agora = {
    enable = true;
    hermesEndpoint = "https://hermes.example.com";
    port = 5173;
    # profile = "work";
  };
}
```

The module builds the package automatically. `services.agora.package` can
override it. `profile` is compiled into the default package; a custom package
must configure its own `hermesProfile` argument.

The `agora.service` system service uses a dynamic user, starts after networking,
and restarts on failure. It only listens on `127.0.0.1`; no firewall port is
opened. With `publicOrigin = null`, use a browser on the NixOS machine. The endpoint must support Hermes's
native PKCE login. Session grants stay in process memory, so a service restart
requires signing in again. The service does not read or write Hermes storage.

```sh
systemctl status agora
journalctl -u agora
```

## Public hosting with the Node bridge

> [!WARNING]
> **Hosted bridge login requires a change to Hermes.** Its native PKCE broker
> must accept an explicitly allowlisted HTTPS callback. The documented Hermes
> baseline accepts only loopback callbacks. Apply the patch in the Hermes build;
> Agora's package and module do not apply it. Laptop mode needs no patch.

Import the module as above, then configure Agora and Caddy on the serving machine:

```nix
{
  services.agora = {
    enable = true;
    hermesEndpoint = "https://hermes.foo.bar";
    publicOrigin = "https://agora.foo.bar";
    port = 5173;
  };

  services.caddy = {
    enable = true;
    virtualHosts."agora.foo.bar".extraConfig = ''
      reverse_proxy 127.0.0.1:5173
    '';
  };
  networking.firewall.allowedTCPPorts = [ 80 443 ];
}
```

Point the Agora DNS record to this machine. Caddy terminates HTTPS and proxies
all paths, including WebSocket upgrades, to Agora. The module runs the packaged
Node process on loopback; it does not configure a reverse proxy or open ports.
Keep this HTTP listener restricted to the same machine as the TLS proxy.

For Nginx, configure an HTTPS virtual host with one location:

```nix
services.nginx.virtualHosts."agora.foo.bar" = {
  forceSSL = true;
  enableACME = true;
  locations."/" = {
    proxyPass = "http://127.0.0.1:5173";
    proxyWebsockets = true;
    recommendedProxySettings = true;
    extraConfig = ''
      proxy_read_timeout 300s;
      proxy_send_timeout 300s;
      proxy_buffering off;
    '';
  };
};
```

Enable Nginx and configure ACME terms/email as usual. Preserve the public Host
and browser Origin. Do not proxy API/auth paths directly to Hermes or serve a
separate SPA fallback: the Node service serves the UI and owns the Agora callback.
It validates Host against `publicOrigin`, checks Origin on mutations/WebSockets,
and uses the configured origin for cookies and callbacks. Forwarded headers
cannot override that origin. The origin must be a canonical lowercase HTTPS
origin with no path, query, credentials, or fragment; omit the default `:443`.

### Hermes requirement

Keep Hermes's existing OIDC provider, `dashboard.public_url`, and provider callback
at `https://hermes.foo.bar/auth/callback`. In the patched native broker, allow
exactly `https://agora.foo.bar/auth/native/callback`. The allowlist's setting name
is defined by your patch; no such setting exists in the source baseline.
This is a second redirect performed by Hermes after the provider completes login,
not a new provider callback.

Hermes must advertise `native_pkce` through `/api/status`. The Node service
exchanges the one-time code with PKCE, keeps access/refresh tokens in memory,
and authenticates upstream HTTP requests with bearer tokens. It mints WebSocket
tickets and opens the upstream socket without a browser Origin. The browser
uses only the Agora origin, so neither proxy needs CORS headers or Origin rewrites.

### Runtime and options

| Option | Default | Purpose |
| --- | --- | --- |
| `enable` | `false` | Run the Node service. |
| `hermesEndpoint` | Required | Hermes dashboard endpoint, HTTPS or HTTP on loopback. |
| `publicOrigin` | `null` | Public HTTPS origin; null keeps laptop mode. |
| `port` | `5173` | Loopback HTTP port, used directly or by the reverse proxy. |
| `profile` | `null` | Profile compiled into the default package. |
| `package` | Module's package | Override the packaged application. |

`publicOrigin` sets `AGORA_PUBLIC_ORIGIN` at runtime; it does not rebuild the UI.
The bridge uses Secure, HttpOnly, host-only session/login cookies in hosted mode.
Tokens are not written to disk. A process restart loses login sessions; a page
refresh does not. Run a single process: multiple replicas do not share the
in-memory login/session state. Logout clears the Agora session and sockets;
it does not revoke your provider SSO session or sign out the Hermes dashboard.

Open Agora, sign in, and check that the final redirect returns to its
`/auth/native/callback`, then to `/`. `/api/auth/me` should return 200 and
`/api/ws` should upgrade with 101. Verify refresh, image loading, and logout.
An upstream 400 rejecting the callback means the Hermes patch/allowlist is
missing or does not match. A bridge 403 means public Host/Origin forwarding or
`publicOrigin` is incorrect. Check `journalctl -u agora` and proxy logs, but do
not log callback query strings containing one-time codes.

Tests exercise hosted login against a synthetic Hermes server. Live OIDC with
the patched Hermes deployment remains to be verified.

## Verify changes

From this repository:

```sh
nix flake check . --no-build
nix build .
nix eval --impure --json --expr 'let flake = builtins.getFlake (toString ./.); pkgs = import flake.inputs.nixpkgs { system = "x86_64-linux"; }; in import ./tests/nixos-module.nix { inherit pkgs; module = flake.nixosModules.default; }'
```

After building with a `result` link, run `node tests/nix-package.mjs ./result`
from the development shell to check the packaged server and favicon responses
from a separate working directory. The smoke check uses a loopback placeholder
endpoint and does not contact Hermes. Also run
`node tests/nix-package.mjs ./result https://agora.example.com` to check hosted
startup, public Host validation, and static assets through the configured Host.

When `package-lock.json` changes, update `npmDepsHash` in `nix/package.nix`.
Temporarily set it to `lib.fakeHash`, build, and use the hash reported by Nix.
