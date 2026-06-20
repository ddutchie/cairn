// Sharp stub — exports a truthy no-op so transformers.js's image.js module
// passes the `else if (sharp)` check without pulling in the native binary.
// The image-processing code path sets up `loadImageFunction` using `sharp`
// but Cairn never calls it (text tokenization only). A function matches
// sharp's normal API shape (sharp is callable) but is never invoked.
export default function sharp() {
  throw new Error("sharp stub: image processing is not available");
}
