declare module 'stream-json' {
  import { Transform } from 'stream';
  function parser(): Transform;
  export default { parser };
  export { parser };
}

declare module 'stream-json/filters/Pick.js' {
  import { Transform } from 'stream';
  function pick(options: { filter: string }): Transform;
  export default { pick };
  export { pick };
}

declare module 'stream-json/streamers/StreamArray.js' {
  import { Transform } from 'stream';
  function streamArray(): Transform;
  export default { streamArray };
  export { streamArray };
}
