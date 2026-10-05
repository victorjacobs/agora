{
  description = "Agora, a Hermes chat client";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
    in
    {
      packages = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          agora = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit agora;
          default = agora;
        });

      nixosModules = {
        agora = import ./nix/module.nix;
        default = import ./nix/module.nix;
      };

      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24 git ripgrep imagemagick
              (writeShellScriptBin "agora-dev" "exec npm run dev -- \"$@\"")
              (writeShellScriptBin "agora-start" "exec npm start -- \"$@\"")
              (writeShellScriptBin "agora-screenshot" "exec npm run screenshot -- \"$@\"")
              (writeShellScriptBin "agora-icons" "exec sh scripts/icons.sh")
              (writeShellScriptBin "agora-check" "npm run typecheck && npm test && npm run build")
            ];
          };
        });
    };
}
