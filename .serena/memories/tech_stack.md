# Tech Stack

- Node/TypeScript VS Code extension; CommonJS, ES6 target, strict mode, `noUnusedLocals`.
- Package manager: npm. Build compiles `src` to `out` via `tsc -p ./`; package via `vsce package`.
- Runtime dependencies currently include MobX and Luxon; VS Code API types pinned at 1.90.0.