declare module "cross-zip" {
  export interface CrossZip {
    zip(
      inputPath: string,
      outputPath: string,
      callback: (error?: Error | null) => void,
    ): void;
    zipSync(inputPath: string, outputPath: string): void;
    unzip(
      inputPath: string,
      outputPath: string,
      callback: (error?: Error | null) => void,
    ): void;
    unzipSync(inputPath: string, outputPath: string): void;
  }

  const crossZip: CrossZip;
  export default crossZip;
}

declare module "debug" {
  function debug(namespace: string): debug.Debugger;

  namespace debug {
    interface Debugger {
      (formatter: unknown, ...args: unknown[]): void;
    }
  }

  export default debug;
}
