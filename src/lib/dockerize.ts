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
  const ubuntuVersion = options.ubuntuVersion ?? '20.10';

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


  // ----- [4] Prepare Staging Area --------------------------------------------

  // Get path to a random temporary directory we will use as our staging area.
  const stagingDir = tempy.directory();
  await fs.ensureDir(stagingDir);


  // ----- [5] Compute Node Version, Copy .npmrc, Copy Lockfile ----------------

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


  // ----- [6] Determine Dockerfile Strategy -----------------------------------

  // Path where we want the final Dockerfile to be.
  const targetDockerfilePath = path.join(stagingDir, 'Dockerfile');

  // Path indicating where we found a Dockerfile, or undefined if using a
  // generated one.
  let finalDockerfileSourcePath: string | undefined;

  // [6a] If a `--dockerfile` argument was provided, use the Dockerfile at that
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

  // [6b] Otherwise, if a Dockerfile is present in the build context, use it.
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

  // [6c] Otherwise, programmatically generate a Dockerfile and place it in the
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


  // ----- [7] Construct Docker Command ----------------------------------------

  const dockerBuildArgs = [
    '--rm',
    `--tag=${tag}`,
    `--label=NODE_VERSION=${nodeVersion}`,
    `--label=TINI_VERSION=${DEFAULT_TINI_VERSION}`,
    labels,
    extraArgs
  ].filter(Boolean).join(' ');


  // ----- [8] Log Build Metadata ----------------------------------------------

  log.info(`${emoji.get('whale')}  Dockerizing package ${log.chalk.green(pkg.package.name)}.`);

  log.verbose(`- Package Root: ${log.chalk.green(pkg.root)}`);
  log.verbose(`- Staging Directory: ${log.chalk.green(stagingDir)}`);

  if (extraArgs) {
    log.verbose(`- Extra Docker Args: ${extraArgs}`);
  }

  log.verbose(`- Docker Command: "docker build ${options.cwd} ${dockerBuildArgs}"`);

  if (finalDockerfileSourcePath) {
    log.info(`- Dockerfile: ${log.chalk.green(finalDockerfileSourcePath)}`);
  }

  log.info(`- Entrypoint: ${log.chalk.green(entry)}`);
  log.info(`- Node Version: ${log.chalk.green(nodeVersion)}`);
  log.info(`- Lockfile: ${log.chalk[hasLockfile ? 'green' : 'yellow'](String(hasLockfile))}`);

  if (envVars.length > 0) {
    log.info('- Environment Variables:');

    envVars.forEach(varExpression => {
      const [key, value] = varExpression.split('=');
      log.info(`  - ${key}=${value}`);
    });
  }

  if (options.labels) {
    log.info('- Labels:');

    ensureArray<string>(options.labels).forEach(labelExpression => {
      const [key, value] = labelExpression.split('=');
      log.info(`  - ${key}: ${value}`);
    });
  }


  // ----- [9] Pack Package ----------------------------------------------------

  const spinner = log.createSpinner();

  let endBuildInteractive;

  const buildMessage = `Building image ${log.chalk.cyan(tag)}...`;

  if (log.isLevelAtLeast('silly')) {
    log.info(buildMessage);
  } else {
    endBuildInteractive = log.beginInteractive(() => log.info(`${spinner} ${buildMessage}`));
  }

  // Copy production-relevant package files to the staging directory.
  await packAndExtractPackage(npm, pkg.root, stagingDir);


  // ----- [10] Build Image ----------------------------------------------------

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


  // ----- [11] Compute Image Size & Clean Up ----------------------------------

  const [imageSize] = await Promise.all([
    getImageSize(docker, tag),
    fs.remove(stagingDir)
  ]);

  const endBuildMessage = `${emoji.get('checkered_flag')}  Built image ${log.chalk.cyan(tag)} ${log.chalk.dim(`(${imageSize})`)} in ${buildTime}.`;

  if (endBuildInteractive) {
    endBuildInteractive(() => log.info(endBuildMessage));
  } else {
    log.info(endBuildMessage);
  }


  // ----- [12] (Optional) Push Image ------------------------------------------

  if (!options.push) {
    return;
  }

  const pushTime = log.createTimer();

  let endPushInteractive;

  const pushMessage = `Pushing image ${log.chalk.cyan(tag)}...`;

  if (log.isLevelAtLeast('silly')) {
    log.info(pushMessage);
  } else {
    endPushInteractive = log.beginInteractive(() => log.info(`${spinner} ${pushMessage}`));
  }

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

  const endPushMessage = `${emoji.get('rocket')}  Pushed image ${log.chalk.cyan(tag)} in ${pushTime}.`;

  if (endPushInteractive) {
    endPushInteractive(() => log.info(endPushMessage));
  } else {
    log.info(endPushMessage);
  }
}
