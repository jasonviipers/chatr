/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly REACT_APP_NAME: string;
  readonly REACT_APP_HOST: string;
  readonly REACT_APP_TAGLINE: string;
  readonly REACT_APP_API_HOST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
