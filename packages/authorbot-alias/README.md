# authorbot

The unscoped name for [`@authorbot/cli`](https://www.npmjs.com/package/@authorbot/cli).

```sh
npx authorbot validate .
npx authorbot build . --out _site
```

This package contains no logic of its own. It depends on `@authorbot/cli` at
the exact same version and forwards to its binary, so the command named
throughout Authorbot's documentation and generated CI workflows resolves to the
toolchain those instructions were written for.

Installing either package gives you the same `authorbot` command. If you are
adding a dependency to a book repository, prefer `@authorbot/cli` - that is
what the generated `package.json` pins.

- [Source and issues](https://github.com/JoeMattie/authorbot)

MIT licensed.
