{
  description = "TeamClaude packaged as a dependency-free Node application";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          teamclaude = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit teamclaude;
          default = teamclaude;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # `nix flake check` builds the package on every system.
          package = self.packages.${system}.teamclaude;
        }
        # The NixOS VM test only runs on Linux (nixosTest requires a Linux host).
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixos-module = import ./nix/tests/module.nix { inherit pkgs self system; };
        }
      );

      apps = forAllSystems (system: {
        teamclaude = {
          type = "app";
          program = "${self.packages.${system}.teamclaude}/bin/teamclaude";
          meta = {
            inherit (self.packages.${system}.teamclaude.meta) description;
          };
        };
        default = self.apps.${system}.teamclaude;
      });

      nixosModules = {
        teamclaude = import ./nix/module.nix;
        default = self.nixosModules.teamclaude;
      };

      homeManagerModules = {
        teamclaude = import ./nix/home-manager-module.nix;
        default = self.homeManagerModules.teamclaude;
      };
    };
}
