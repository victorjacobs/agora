{ pkgs, module ? ../nix/module.nix }:

let
  evaluate = settings: import (pkgs.path + "/nixos/lib/eval-config.nix") {
    system = "x86_64-linux";
    modules = [
      module
      {
        system.stateVersion = "26.05";
        services.agora = settings;
      }
    ];
  };
  enabled = (evaluate {
    enable = true;
    hermesEndpoint = "https://hermes.example.com";
    port = 8123;
    profile = "work";
  }).config;
  disabled = (evaluate { }).config;
  insecure = (evaluate {
    enable = true;
    hermesEndpoint = "http://hermes.example.com";
  }).config;
  hosted = (evaluate {
    enable = true;
    hermesEndpoint = "https://hermes.foo.bar";
    publicOrigin = "https://agora.foo.bar";
  }).config;
  invalidOrigin = (evaluate {
    enable = true;
    hermesEndpoint = "https://hermes.foo.bar";
    publicOrigin = "https://agora.foo.bar/path";
  }).config;
  service = enabled.systemd.services.agora;
  failedAssertions = cfg: builtins.filter
    (entry: !entry.assertion)
    cfg.assertions;
in
assert service.environment.HERMES_ENDPOINT == "https://hermes.example.com";
assert service.environment.AGORA_PORT == "8123";
assert !(service.environment ? AGORA_PUBLIC_ORIGIN);
assert hosted.systemd.services.agora.environment.AGORA_PUBLIC_ORIGIN == "https://agora.foo.bar";
assert !(builtins.any (entry: pkgs.lib.hasPrefix "services.agora.publicOrigin" entry.message) (failedAssertions hosted));
assert builtins.any (entry: pkgs.lib.hasPrefix "services.agora.publicOrigin" entry.message) (failedAssertions invalidOrigin);
assert service.serviceConfig.ExecStart == "${enabled.services.agora.package}/bin/agora";
assert service.serviceConfig.DynamicUser;
assert service.serviceConfig.ProtectSystem == "strict";
assert service.wantedBy == [ "multi-user.target" ];
assert enabled.services.agora.package.VITE_HERMES_PROFILE == "work";
assert !(disabled.systemd.services ? agora);
assert !(builtins.any (entry: pkgs.lib.hasPrefix "services.agora.hermesEndpoint" entry.message) (failedAssertions enabled));
assert builtins.any (entry: pkgs.lib.hasPrefix "services.agora.hermesEndpoint" entry.message) (failedAssertions insecure);
{
  result = "passed";
  unit = enabled.systemd.units."agora.service".text;
}
