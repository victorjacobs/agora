{ config, lib, pkgs, ... }:

let
  cfg = config.services.agora;
  inherit (lib) mkEnableOption mkIf mkOption types;
in
{
  options.services.agora = {
    enable = mkEnableOption "the Agora Hermes connection service";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { hermesProfile = cfg.profile; };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { hermesProfile = config.services.agora.profile; }";
      description = "Agora package to run.";
    };

    hermesEndpoint = mkOption {
      type = types.str;
      example = "https://hermes.example.com";
      description = "Hermes built-in dashboard endpoint. Requires HTTPS except for loopback test servers.";
    };

    publicOrigin = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://agora.example.com";
      description = "Public HTTPS origin when running behind a reverse proxy. Null uses laptop loopback login. Hosted login requires Hermes to allow this origin's /auth/native/callback through its native broker.";
    };

    port = mkOption {
      type = types.port;
      default = 5173;
      description = "HTTP port on 127.0.0.1. In hosted mode, proxy the public origin to this port.";
    };

    profile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Hermes profile baked into the default package's UI. Null uses the server's launch profile. With a custom package, configure its hermesProfile argument instead.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "https://" cfg.hermesEndpoint
          || builtins.match "http://(127[.]0[.]0[.]1|localhost|[[]::1[]])(:[0-9]+)?(/.*)?" cfg.hermesEndpoint != null;
        message = "services.agora.hermesEndpoint must use HTTPS, or HTTP on loopback.";
      }
      {
        assertion = cfg.publicOrigin == null || builtins.match "https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?/?" cfg.publicOrigin != null;
        message = "services.agora.publicOrigin must be an HTTPS origin without credentials, path, query, or fragment.";
      }
    ];

    systemd.services.agora = {
      description = "Agora Hermes chat client";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        HERMES_ENDPOINT = cfg.hermesEndpoint;
        AGORA_PORT = toString cfg.port;
        NODE_ENV = "production";
      } // lib.optionalAttrs (cfg.publicOrigin != null) {
        AGORA_PUBLIC_ORIGIN = cfg.publicOrigin;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "15s";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      };
    };
  };
}
