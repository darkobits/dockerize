<a href="#top" id="top">
  <img src="https://user-images.githubusercontent.com/441546/101590073-973e7180-399e-11eb-9980-682d6a6856da.png" style="max-width: 100%;">
</a>
<p align="center">
  <a href="https://www.npmjs.com/package/@darkobits/dockerize"><img src="https://img.shields.io/npm/v/@darkobits/dockerize.svg?style=flat-square"></a>
  <a href="https://github.com/darkobits/dockerize/actions?query=workflow%3ACI"><img src="https://img.shields.io/github/workflow/status/darkobits/dockerize/CI/master?style=flat-square"></a>
  <a href="https://depfu.com/github/darkobits/dockerize"><img src="https://img.shields.io/depfu/darkobits/dockerize?style=flat-square"></a>
  <a href="https://conventionalcommits.org"><img src="https://img.shields.io/static/v1?label=commits&message=conventional&style=flat-square&color=398AFB"></a>
</p>

Make containerizing a Node project as straightforward as using `npm publish`. No `Dockerfile` required.

This project uses idiomatic standards (ie: `"files"`, `"main"`, `"bin"` in `package.json`) to determine
which files in a project are production-relevant. It uses `npm pack` under the hood, which is what
`npm publish` uses to create package tarballs. It uses sane defaults and adheres to best practices for
containerizing Node applications.

## Install

Dockerize may be installed globally, though it is recommended that it be installed as a development
dependency of an existing project.

```sh
$ npm i --dev @darkobits/dockerize
```

You must also have Docker installed on your system with the `docker` command in your `PATH`.

## Use

Dockerize uses a project's `package.json` to infer which files should be included in images and which
file to use as the image's [entrypoint](https://docs.docker.com/engine/reference/builder/#entrypoint).
By default, it will use the first (or only) `"bin"` value, if present. Otherwise, it will use `"main"`.
All files enumerated in `"files"` will be included in the image.

**Example:**

Let's imagine we are developing a web server that we want to containerize. We're using [Babel](https://babeljs.io/)
to transpile our source files to a `dist` folder in our project root. This project's `package.json`
(sans dependencies) may look like the following:

> `package.json`

```json
{
  "name": "web-server-demo",
  "version": "0.1.0",
  "files": [
    "dist"
  ],
  "main": "dist/server.js",
  "scripts": {
    "dockerize": "dockerize"
  }
}
```

To containerize this project, we can run `npm run dockerize`, which will invoke the Dockerize CLI via
the above package script.

This will produce a Docker image with the tag `web-server-demo:0.1.0` using the [current LTS version of Node](https://nodejs.org).
To start our containerized web server, we can run:

```sh
$ docker run --interactive --tty web-server-demo:0.1.0
```

## Options

Dockerize accepts the following named arguments, which may be set via command-line flags or via a
configuration file, which may be any of the following:

| Name                   | Format    |
|------------------------|-----------|
| `.dockerize.json`     | JSON       |
| `.dockerize.yml`      | YAML       |
| `dockerize.config.js` | JavaScript |

**Example:**

> `.dockerize.yml`

```yml
node-version: '12.1.3'
ubuntu-version: '19.04'
label:
  - rainbows=true
  - unicorns=true
env:
  - FOO=1
push: true
```

### `cwd`

Required: `false`<br>
Default: `process.cwd()`

> This is a positional argument when using the CLI and a named option when using the API.

Root of the project to containerize. This argument works just like `docker build`'s first positional
argument. This directory should contain a `package.json`.

**Example:**

```sh
$ dockerize ~/projects/spline-reticulator
```

### `--dockerfile`

Required: `false`<br>
Default: See below.

Optional path to a custom `Dockerfile` to use. If not provided, Dockerize will look for a `Dockerfile`
in the root of the build context (see `cwd` argument above). If the build context does not contain a
`Dockerfile`, Dockerize will programmatically generate one for you with the following properties:

* The [Ubuntu 19.04 image](https://hub.docker.com/_/ubuntu) will be used as a base, which is "minimal" by default and therefore relatively small.
* The [current LTS version of Node](https://nodejs.org) will be installed. (See `--node-version` below.)
* The [Tini](https://github.com/krallin/tini) process manager will be installed and configured to ensure proper handling of POSIX signals. This is considered a best practice when using Node in Docker.

**Example:**

```sh
$ dockerize --dockerfile "../path/to/your/Dockerfile"
```

### `--tag`

Required: `false`<br>
Default: See below.

Tag to use for the image.

Dockerize will inspect `package.json` and extract the `name` and `version` fields. It will then remove
any leading `@`, and split the name into its scope (if applicable) and base name components. These
tokens are then used to construct the image's name, and are also available to the user to create a
custom tag format using these data.

|Token|Value|
|:--|:--|
|`{{packageName}}`|Non-scope segment of `name` from `package.json`.|
|`{{packageScope}}`|Scope segment of `name` from `package.json`, sans `@`.|
|`{{packageVersion}}`|`version` from `package.json`.|

The default tag format for scoped packages is: `{{packageScope}}/{{packageName}}:{{packageVersion}}`.

The default tag format for un-scoped packages is: `{{packageName}}:{{packageVersion}}`.

When using the `tag` argument, you may include these tokens and Dockerize will replace them with their
appropriate values.

**Example:**

Suppose we are Dockerizing version `1.2.3` of a package named `@acmeco/spline-reticulator` which we want
to push to a custom Docker registry, `hub.acmeco.com`. The default image name that would be generated
for this package would be `acmeco/spline-reticulator:1.2.3`, and a `docker push` of this image would
assume it should be pushed to the public Docker registry.

Instead, we can pass the following `tag` argument:

```sh
$ dockerize --tag="hub.acmeco.com/{{packageName}}:{{packageVersion}}"
```

Which will produce an image named `hub.acmeco.com/spline-reticulator:1.2.3`. Notice that we don't need
our package scope in this image name since we are publishing to our own private registry. Leveraging a
custom tag format let's us accomplish this.

### `--node-version`

Required: `false`<br>
Default: LTS

By default, Dockerize will use the current LTS version of Node. The LTS, or Long-Term Support version of
Node provides the best balance of modern language features and stability. If your project requires a
specific Node version, you may provide it using this flag.

**Example:**

```sh
$ dockerize --node-version="14.15.0"
```

**Note:** This argument is moot when the `--dockerfile` flag is used.

### `--ubuntu-version`

Required: `false`<br>
Default: `20.10`

Ubuntu version to use as a base image. This option supports any valid tag for the [public `ubuntu` image](https://hub.docker.com/_/ubuntu/).

**Example:**

```sh
$ dockerize --ubuntu-version="latest"
```

**Note:** This argument is moot when the `--dockerfile` flag is used.

### `--npmrc`

Required: `false`<br>
Default: N/A

If your project has production dependencies that are installed from private registries or otherwise
require authorization, NPM will need to be configured using an `.npmrc` file. Most of the time, this
file will not be present in the build context and will therefore not be available when `npm install` is
called when building the image. If your project requires an `.npmrc` file in order to install
dependencies, you may provide a path to this file using this argument.

**Example:**

```sh
$ dockerize --npmrc="~/.npmrc"
```

**Note:** If an `.npmrc` file is used, it will be deleted from the image once dependencies are
installed.

**Note:** This argument is moot when the `--dockerfile` flag is used.

### `--label`

Required: `false`<br>
Default: N/A

Apply one or more labels to the image. This argument works just like `docker build`'s `--label`
argument, and may be used multiple times to apply multiple labels. Quoting each value when using this
argument is recommended.

**Example:**

```sh
$ dockerize --label="foo=bar" --label="baz=qux"
```

### `--env`

Required: `false`<br>
Default: N/A

Set one or more environment variables in the image. This argument works just like `docker build`'s
`--env` argument, and may be used multiple times to apply multiple environment variables. Quoting each
value when using this argument is recommended.

**Example:**

```sh
$ dockerize --env="RETICULATE_SPLINES=1"
```

### `--extra-args`

Required: `false`<br>
Default: N/A

Any additional arguments to provide to the call to `docker build`. This value should be a single quoted
string.

**Example:**

```sh
$ dockerize --extra-args="--force-rm --squash"
```

### `--push`

Required: `false`<br>
Default: `false`

Whether to call `docker push` after building an image.

## Node API

Dockerize can also be used programmatically. This package's default export is a function that accepts a
single options object per the above specification.

**Example:**

```js
import Dockerize from '@darkobits/dockerize';

await Dockerize({
  nodeVersion: '14.15.0',
  // These options should use the singular form for their key, but their values may be strings
  // or arrays of strings.
  label: ['foo=bar', 'baz=qux'],
  env: ['EDITOR=vim']
});
```

## Debugging

This tool respects the `LOG_LEVEL` environment variable. It may be set to `verbose` or `silly` to enable
additional logging.

<br />
<a href="#top">
  <img src="https://user-images.githubusercontent.com/441546/118062198-4ff04e80-b34b-11eb-87f3-406a345d5526.png" style="max-width: 100%;">
</a>
