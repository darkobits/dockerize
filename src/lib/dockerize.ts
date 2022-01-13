import path from 'path';

import chex from '@darkobits/chex';
import fs from 'fs-extra';
import emoji from 'node-emoji';
import ow from 'ow';
import tempy from 'tempy';

import { DEFAULT_TINI_VERSION } from 'etc/constants';
import { DockerizeOptions } from 'etc/types';
import log from 'lib/log';
import {
  computePackageEntry,
  computeTag,
  copyPackageLockfile,
  copyNpmrc,
  ensureArray,
  getImageSize,
  getNodeLtsVersion,
  packAndExtractPackage,
  parseLabels,
  pkgInfo,
  renderTemplate
} from 'lib/utils';


export default async function dockerize(options: DockerizeOptions) {
  const buildTime = log.createTimer();

  // Ensure Docker and NPM are installed.
  const [docker, npm] = await Promise.all([chex('docker'), chex('npm')]);


  // ----- [1] Validate Options ------------------------------------------------

  ow(options.cwd, 'cwd', ow.string);
  ow(options.tag, 'tag', ow.any(ow.undefined, ow.string));
  ow(options.nodeVersion, 'Node version', ow.any(ow.undefined, ow.string));
  ow(options.ubuntuVersion, 'Ubuntu version', ow.any(ow.undefined, ow.string));
  ow(options.labels, 'labels', ow.any(ow.undefined, ow.string, ow.array.ofType(ow.string)));
  ow(options.env, 'environment variables', ow.any(ow.undefined, ow.string, ow.array.ofType(ow.string)));
  ow(options.extraArgs, 'extra Docker arguments', ow.any(ow.undefined, ow.string));
  ow(options.dockerfile, 'custom Dockerfile', ow.any(ow.undefined, ow.string));
  ow(options.npmrc, '.npmrc file', ow.any(ow.undefined, ow.string));
  ow(options.push, 'push', ow.any(ow.undefined, ow.boolean));


  // ----- [2] Introspect Host Package -----------------------------------------

  // Get the path to the package's package.json and create the staging area.
  const pkg = await pkgInfo({ cwd: options.cwd });

  // Compute path to the package's entrypoint ("bin" or "main"). This will be
  // used as the ENTRYPOINT in the final image.
  const entry = computePackageEntry(pkg.package);


  // ----- [3] Parse Options ---------------------------------------------------

  /**
   * Ubuntu version to use as a base image.
   */
  const ubuntuVersion = options.ubuntuVersion ?? '22.04';

  /**
   * Tag that will be applied to the image.
   */
  const tag = computeTag(options.tag, pkg.package);

  /**
   * Additional labels to apply to the image.
   */
  const labels = parseLabels(options.labels);

  /**
   * Environment variables to set in the image.
   */
  const envVars = ensureArray<string>(options.env);

  /**
   * Extra arguments to pass to `docker build`.
   */
  const extraArgs = options.extraArgs;

  /**
   * Path to a custom Dockerfile to use.
   */
  const customDockerfile = options.dockerfile;


  // ----- [4] Ensure Docker Daemon is Running ---------------------------------

  try {
    await docker('info');
  } catch (err: any) {
    const search = 'ERROR:';
    if (err.stdout.includes(search)) {
      const idx = err.stdout.indexOf(search) as number;
      const message = err.stdout.slice(idx + search.length).trim();
      throw new Error(message);
    }
  }


  // ----- [5] Prepare Staging Area --------------------------------------------

  // Get path to a random temporary directory we will use as our staging area.
  const stagingDir = tempy.directory();
  await fs.ensureDir(stagingDir);


  // ----- [6] Compute Node Version, Copy .npmrc, Copy Lockfile ----------------

  const [
    /**
     * Version of NodeJS that will be installed in the container.
     */
    nodeVersion,

    /**
     * Custom .npmrc file to use when installing packages.
     */
    hasNpmrc,

    /**
     * Resolves with `true` if the project has a lockfile.
     */
    hasLockfile
  ] = await Promise.all([
    options.nodeVersion ?? getNodeLtsVersion(),
    // N.B. These two files are not included in `npm pack`, so we have to copy
    // them explicitly.
    copyNpmrc(options.npmrc, stagingDir),
    copyPackageLockfile(pkg.root, path.join(stagingDir, 'package'))
  ]);


  // ----- [7] Determine Dockerfile Strategy -----------------------------------

  // Path where we want the final Dockerfile to be.
  const targetDockerfilePath = path.join(stagingDir, 'Dockerfile');

  // Path indicating where we found a Dockerfile, or undefined if using a
  // generated one.
  let finalDockerfileSourcePath: string | undefined;

  // [7a] If a `--dockerfile` argument was provided, use the Dockerfile at that
  // path.
  if (customDockerfile) {
    try {
      const absoluteCustomDockerfilePath = path.resolve(customDockerfile);
      await fs.access(absoluteCustomDockerfilePath);
      finalDockerfileSourcePath = absoluteCustomDockerfilePath;
      await fs.copy(absoluteCustomDockerfilePath, targetDockerfilePath);
    } catch (err: any) {
      throw new Error(`Error reading custom Dockerfile: ${err.message}`);
    }
  }

  // [7b] Otherwise, if a Dockerfile is present in the build context, use it.
  if (!finalDockerfileSourcePath) {
    try {
      const contextDockerfilePath = path.resolve(options.cwd, 'Dockerfile');
      await fs.access(contextDockerfilePath);
      finalDockerfileSourcePath = contextDockerfilePath;
      return await fs.copy(contextDockerfilePath, targetDockerfilePath);
    } catch  {
      // Context does not have a Dockerfile, we can safely recover from this and
      // move on to generating our own.
    }
  }

  // [7c] Otherwise, programmatically generate a Dockerfile and place it in the
  // build context.
  if (!finalDockerfileSourcePath) {
    await renderTemplate({
      template: path.join(__dirname, '..', 'etc', 'Dockerfile.ejs'),
      dest: targetDockerfilePath,
      data: {
        entry,
        envVars,
        hasLockfile,
        nodeVersion,
        ubuntuVersion,
        tiniVersion: DEFAULT_TINI_VERSION,
        hasNpmrc
      }
    });
  }


  // ----- [8] Construct Docker Command ----------------------------------------

  const dockerBuildArgs = [
    '--rm',
    // Needed for M1 Macs.
    // See: https://stackoverflow.com/questions/68630526/lib64-ld-linux-x86-64-so-2-no-such-file-or-directory-error
    '--platform=linux/x86_64',
    `--tag=${tag}`,
    `--label=NODE_VERSION=${nodeVersion}`,
    `--label=TINI_VERSION=${DEFAULT_TINI_VERSION}`,
    labels,
    extraArgs
  ].filter(Boolean).join(' ');


  // ----- [9] Log Build Metadata ----------------------------------------------

  log.info(`${emoji.get('whale')} Dockerizing package ${log.chalk.green(pkg.package.name)}.`);

  log.verbose(`-> Package Root: ${log.chalk.green(pkg.root)}`);
  log.verbose(`-> Staging Directory: ${log.chalk.green(stagingDir)}`);

  if (extraArgs) {
    log.verbose(`-> Extra Docker Args: ${extraArgs}`);
  }

  const dockerBuildCommand = `docker build ${options.cwd} ${dockerBuildArgs}`;
  log.verbose(`-> Docker Command: ${log.chalk.dim(dockerBuildCommand)}`);

  if (finalDockerfileSourcePath) {
    log.info(`-> Dockerfile: ${log.chalk.green(finalDockerfileSourcePath)}`);
  }

  log.info(`-> Entrypoint: ${log.chalk.green(entry)}`);
  log.info(`-> Node Version: ${log.chalk.green(nodeVersion)}`);
  log.info(`-> Lockfile: ${log.chalk[hasLockfile ? 'green' : 'yellow'](String(hasLockfile))}`);

  if (envVars.length > 0) {
    log.info('-> Environment Variables:');

    envVars.forEach(varExpression => {
      const [key, value] = varExpression.split('=');
      log.info(`  -  ${key}=${value}`);
    });
  }

  if (options.labels) {
    log.info('- Labels:');

    ensureArray<string>(options.labels).forEach(labelExpression => {
      const [key, value] = labelExpression.split('=');
      log.info(`  - ${key}: ${value}`);
    });
  }


  // ----- [10] Pack Package ---------------------------------------------------

  log.info(`Building image ${log.chalk.cyan(tag)}...`);

  // Copy production-relevant package files to the staging directory.
  await packAndExtractPackage(npm, pkg.root, stagingDir);


  // ----- [11] Build Image ----------------------------------------------------

  const buildProcess = docker(`build . ${dockerBuildArgs}`, {
    cwd: stagingDir,
    stdin: 'ignore',
    stdout: log.isLevelAtLeast('silly') ? 'pipe' : 'ignore',
    stderr: log.isLevelAtLeast('silly') ? 'pipe' : 'ignore',
    buffer: log.isLevelAtLeast('silly') ? false : true
  });

  if (buildProcess.stdout) {
    buildProcess.stdout.pipe(log.createPipe('silly'));
  }

  if (buildProcess.stderr) {
    buildProcess.stderr.pipe(log.createPipe('error'));
  }

  await buildProcess;


  // ----- [12] Compute Image Size & Clean Up ----------------------------------

  const [imageSize] = await Promise.all([
    getImageSize(docker, tag),
    fs.remove(stagingDir)
  ]);

  log.info(`Image size: ${log.chalk.dim(`${imageSize}`)}`);
  log.info(`Done in ${buildTime}. ${emoji.get('sparkles')}`);

  // ----- [13] (Optional) Push Image ------------------------------------------

  if (!options.push) {
    return;
  }

  const pushTime = log.createTimer();

  log.info(`Pushing image ${log.chalk.cyan(tag)}...`);

  const pushProcess = docker(['push', tag], {
    stdin: 'ignore',
    stdout: log.isLevelAtLeast('silly') ? 'pipe' : 'ignore',
    stderr: log.isLevelAtLeast('silly') ? 'pipe' : 'ignore'
  });

  if (pushProcess.stdout) {
    pushProcess.stdout.pipe(log.createPipe('silly'));
  }

  if (pushProcess.stderr) {
    pushProcess.stderr.pipe(log.createPipe('silly'));
  }

  await pushProcess;

  log.info(`${emoji.get('rocket')}  Pushed image ${log.chalk.cyan(tag)} in ${pushTime}.`);
}
