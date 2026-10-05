# Nix package and NixOS module

The package and module are standalone expressions. The development flake does
not export packages or NixOS modules.

## Build and run

With Nixpkgs available as `<nixpkgs>`:

```sh
nix-build --expr 'let pkgs = import <nixpkgs> {}; in pkgs.callPackage ./nix/package.nix {}'
HERMES_ENDPOINT=https://hermes.example.com ./result/bin/agora
```

Open `http://127.0.0.1:5173/agora/`. Set `AGORA_PORT` to choose another port.
The executable includes Node.js 24, the built UI, and production dependencies;
it runs independently of your working directory. Configure the endpoint with
environment variables, rather than a local `.env.local` file.

The package builds and checks the UI from the committed npm lockfile. Local
environment files, dependencies, and build artifacts are excluded from its
source. To select a Hermes profile when building:

```nix
pkgs.callPackage ./nix/package.nix { hermesProfile = "work"; }
```

## NixOS

Import the module from a checkout or a fetched repository source:

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
opened. Use a browser on the NixOS machine. The endpoint must support Hermes's
native PKCE login. Session grants stay in process memory, so a service restart
requires signing in again. The service does not read or write Hermes storage.

```sh
systemctl status agora
journalctl -u agora
```

## Public hosting alongside Hermes

The loopback login bridge expects a local browser and local Host/Origin headers.
Putting it behind a public reverse proxy is not a supported hosting mode.

Instead, serve `${agoraPackage}/share/agora/dist` at `/agora/` on the same origin
as Hermes, using its existing browser-cookie login. For example, add these
locations to the existing Hermes Nginx virtual host:

```nix
let
  agoraPackage = pkgs.callPackage /path/to/agora/nix/package.nix { };
in {
  services.nginx.virtualHosts."hermes.example.com".locations = {
    "= /agora".return = "302 /agora/";
    "/agora/".alias = "${agoraPackage}/share/agora/dist/";
  };
}
```

Keep Hermes's API, WebSocket, and login routes as described in
[integration.md](integration.md). Agora uses query parameters for conversation
selection, so its current routes do not need a catch-all SPA fallback.

## Verify changes

From this repository, use the flake's pinned Nixpkgs without adding new outputs:

```sh
nix build --impure --no-link --expr 'let pkgs = import (builtins.getFlake (toString ./.)).inputs.nixpkgs { system = builtins.currentSystem; }; in pkgs.callPackage ./nix/package.nix {}'
nix eval --impure --json --expr 'let pkgs = import (builtins.getFlake (toString ./.)).inputs.nixpkgs { system = "x86_64-linux"; }; in import ./tests/nixos-module.nix { inherit pkgs; }'
```

After building with a `result` link, run `node tests/nix-package.mjs ./result`
from the development shell to check the packaged server and favicon responses
from a separate working directory. The smoke check uses a loopback placeholder
endpoint and does not contact Hermes.

When `package-lock.json` changes, update `npmDepsHash` in `nix/package.nix`.
Temporarily set it to `lib.fakeHash`, build, and use the hash reported by Nix.
