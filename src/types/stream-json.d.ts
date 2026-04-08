declare module 'stream-json' {
  import { Transform } from 'stream';
  export function parser(): Transform;
}

declare module 'stream-json/filters/Pick.js' {
  import { Transform } from 'stream';
  export function pick(options: { filter: string }): Transform;
}

declare module 'stream-json/streamers/StreamArray.js' {
  import { Transform } from 'stream';
  export function streamArray(): Transform;
}
