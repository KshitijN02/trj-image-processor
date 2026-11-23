// jsquash decoders construct `new ImageData(...)`, which Node lacks.
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class NodeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace = 'srgb';
    constructor(data: Uint8ClampedArray | number, width: number, height?: number) {
      if (typeof data === 'number') {
        this.width = data;
        this.height = width;
        this.data = new Uint8ClampedArray(data * width * 4);
      } else {
        this.data = data;
        this.width = width;
        this.height = height ?? data.length / 4 / width;
      }
    }
  }
  (globalThis as { ImageData?: unknown }).ImageData = NodeImageData;
}
