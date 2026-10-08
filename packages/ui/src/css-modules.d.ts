/** XYFlow structural CSS is privately bundled with the editor. */
declare module '@xyflow/react/dist/base.css'

/** CSS Modules class names emitted by the shared client bundler. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
