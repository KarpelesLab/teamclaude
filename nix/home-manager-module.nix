{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.teamclaude;

  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    optionalString
    types
    ;

  defaultPackage = pkgs.callPackage ./package.nix { };
  configFile =
    if cfg.configFile == null then "${config.xdg.configHome}/teamclaude.json" else cfg.configFile;
  stateDirectory =
    if cfg.stateDirectory == null then "${config.xdg.stateHome}/teamclaude" else cfg.stateDirectory;

  serverArgs = [
    "server"
    "--headless"
  ]
  ++ lib.optionals (cfg.logDirectory != null) [
    "--log-to"
    cfg.logDirectory
  ]
  ++ cfg.extraArgs;

  preStart = pkgs.writeShellScript "teamclaude-user-pre-start" (
    ''
      set -eu

      config_dir="$(${pkgs.coreutils}/bin/dirname ${lib.escapeShellArg configFile})"
      ${pkgs.coreutils}/bin/install -d -m 0700 "$config_dir"
      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg stateDirectory}
    ''
    + optionalString (cfg.configSource != null) ''

      if [ ! -e ${lib.escapeShellArg configFile} ]; then
        ${pkgs.coreutils}/bin/install -m 0600 \
          ${lib.escapeShellArg cfg.configSource} ${lib.escapeShellArg configFile}
      fi
    ''
    + optionalString (cfg.logDirectory != null) ''

      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg cfg.logDirectory}
    ''
  );
in
{
  options.services.teamclaude = {
    enable = mkEnableOption "TeamClaude user proxy service";

    package = mkOption {
      type = types.package;
      default = defaultPackage;
      defaultText = literalExpression "pkgs.callPackage ./nix/package.nix { }";
      description = "TeamClaude package to run.";
    };

    installPackage = mkOption {
      type = types.bool;
      default = true;
      description = "Whether to add the TeamClaude CLI package to home.packages.";
    };

    configFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.config/teamclaude.json";
      description = ''
        Mutable TeamClaude config path. When null, the module uses
        xdg.configHome/teamclaude.json.

        This should be writable by the user service because TeamClaude persists
        refreshed OAuth tokens, account changes, routes, quota settings, and
        runtime state next to the config.
      '';
    };

    configSource = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = literalExpression "config.sops.secrets.teamclaude-config.path";
      description = ''
        Optional seed config copied to configFile only when configFile does not
        already exist. This is intended for sops-nix Home Manager integration or
        another user-readable secret provider.
      '';
    };

    stateDirectory = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.local/state/teamclaude";
      description = ''
        Working directory created for the user service. When null, the module
        uses xdg.stateHome/teamclaude.
      '';
    };

    host = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "127.0.0.1";
      description = ''
        Optional bind host override passed through TEAMCLAUDE_HOST. Leave null
        to use TeamClaude's config/default behavior.
      '';
    };

    logDirectory = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.local/state/teamclaude/logs";
      description = "Optional request/response log directory passed via --log-to.";
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "--no-tui" ];
      description = "Extra command-line arguments appended to teamclaude server --headless.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS = "120000";
      };
      description = "Extra environment variables for the TeamClaude user service.";
    };

    serviceConfig = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = literalExpression ''
        {
          RestartSec = "10s";
        }
      '';
      description = "Extra systemd user service settings merged into Service.";
    };
  };

  config = mkIf cfg.enable {
    home.packages = mkIf cfg.installPackage [ cfg.package ];

    systemd.user.services.teamclaude = {
      Unit = {
        Description = "TeamClaude proxy";
      };

      Service = {
        Type = "simple";
        ExecStartPre = "${preStart}";
        ExecStart = "${lib.getExe cfg.package} ${lib.escapeShellArgs serverArgs}";
        Restart = "on-failure";
        RestartSec = "5s";
        WorkingDirectory = stateDirectory;
        Environment = [
          "TEAMCLAUDE_CONFIG=${configFile}"
          "TEAMCLAUDE_DISABLE_AUTOUPDATE=1"
        ]
        ++ lib.optionals (cfg.host != null) [
          "TEAMCLAUDE_HOST=${cfg.host}"
        ]
        ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.environment;
      }
      // cfg.serviceConfig;

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
  };
}
