/// <reference types="vite/client" />

declare module "utif" {
  type TiffFrame = { width: number; height: number };
  const UTIF: {
    decode: (buffer: ArrayBuffer) => TiffFrame[];
    decodeImage: (buffer: ArrayBuffer, frame: TiffFrame) => void;
    toRGBA8: (frame: TiffFrame) => Uint8Array;
  };
  export default UTIF;
}

declare module "opentype.js" {
  export type OpentypeGlyph = {
    name?: string;
    unicode?: number;
    getPath: (x: number, y: number, fontSize: number) => { draw: (ctx: CanvasRenderingContext2D) => void };
  };

  export function parse(buffer: ArrayBuffer): {
    glyphs: {
      length: number;
      get: (index: number) => OpentypeGlyph | undefined;
    };
  };
}
