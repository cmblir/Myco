// Vite `?url` imports for binary assets bundled from src/ (e.g. the spaceship
// GLB) — vite/client only declares the common image/font suffixes.
declare module "*.glb?url" {
  const url: string;
  export default url;
}
