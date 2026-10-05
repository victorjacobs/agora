{ config, lib, pkgs, ... }:

let
  cfg = config.services.agora;
  inherit (lib) mkEnableOption mkIf mkOption types;
in
{
  options.services.agora = {
    enable = mkEnableOption "the Agora loopback chat service";

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

    port = mkOption {
      type = types.port;
      default = 5173;
      description = "HTTP port on 127.0.0.1. Open /agora/ in a browser on this machine.";
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
