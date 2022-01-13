#!/usr/bin/env node

import os from 'os';

import cli from '@darkobits/saffron';

import { DockerizeOptions } from 'etc/types';
import dockerize from 'lib/dockerize';
import log from 'lib/log';


/**
 * Singularize `labels` for CLI options. Multiple labels can be applied by using
 * the flag more than once.
 */
interface DockerizeArguments extends Omit<DockerizeOptions, 'labels'> {
  label: DockerizeOptions['labels'];
}


cli.command<DockerizeArguments>({
  command: '* [cwd]',
  builder: ({command}) => {
    command.positional('cwd', {
      description: 'Directory of the project to Dockerize.',
      type: 'string',
      required: false
    });

    command.option('tag', {
      group: 'Optional Arguments:',
      description: 'Tag to use for the image. [Default: Package name]',
      required: false,
      type: 'string'
    });

    command.option('node-version', {
      group: 'Optional Arguments:',
      description: 'Node version to install in the image. [Default: LTS]',
      required: false,
      type: 'string',
      conflicts: ['dockerfile']
    });

    command.option('ubuntu-version', {
      group: 'Optional Arguments:',
      description: 'Ubuntu version to use as a base image. [Default: 20.10]',
      required: false,
      type: 'string',
      conflicts: ['dockerfile']
    });

    command.option('label', {
      group: 'Optional Arguments:',
      description: 'Labels to apply to the image. May be used multiple times.',
      required: false,
      type: 'string'
    });

    command.option('env', {
      group: 'Optional Arguments:',
      description: 'Environment variables to set in the image. May be used multiple times.',
      required: false,
      type: 'string',
      conflicts: ['dockerfile']
    });

    command.option('extra-args', {
      group: 'Optional Arguments:',
      description: 'Optional extra arguments to pass to "docker build". This is treated as a single string and should be quoted.',
      required: false,
      type: 'string'
    });

    command.option('npmrc', {
      group: 'Optional Arguments:',
      description: 'Path to an .npmrc file to use when installing packages.\nOr set to true to use the closest .npmrc file.',
      required: false,
      type: 'string',
      conflicts: ['dockerfile']
    });

    command.option('push', {
      group: 'Optional Arguments:',
      description: 'Whether to call `docker push` after building images.',
      required: false,
      type: 'boolean',
      default: false
    });

    command.option('dockerfile', {
      group: 'Advanced:',
      description: 'Path to a custom Dockerfile to use.\n--node-version and --npmrc are moot when using this option.',
      required: false,
      type: 'string',
      conflicts: ['npmrc', 'nodeVersion']
    });

    command.example('$0', 'Dockerize the NodeJS project in the current directory using default options.');
    command.example('$0 --label="foo=bar" --label="baz=qux" --extra-args="--squash"', 'Dockerize the NodeJS project in the current directory, apply two labels, and pass the --squash argument to Docker.');
  },
  handler: async ({ argv }) => {
    try {
      // Log level is 'silent' by default for Node API use cases; set it to
      // LOG_LEVEL or 'info' by default for CLI use.
      log.configure({
        level: process.env.LOG_LEVEL ?? 'info'
      });

      await dockerize({
        cwd: argv.cwd || process.cwd(),
        tag: argv.tag,
        nodeVersion: argv.nodeVersion,
        ubuntuVersion: argv.ubuntuVersion,
        labels: argv.label,
        env: argv.env,
        extraArgs: argv.extraArgs,
        dockerfile: argv.dockerfile,
        npmrc: argv.npmrc,
        push: argv.push
      });
    } catch (err: any) {
      let message: string;
      let stackLines: Array<string>;

      // N.B. Errors from ow are of type ArgumentError.
      if (err && err.name === 'ArgumentError') {
        message = err.message;
        stackLines = err.stack.split(os.EOL).filter((line: string) => !line.startsWith('- '));
      } else {
        [message, ...stackLines] = err.stack.split(os.EOL);
      }

      log.error(message);
      log.verbose(stackLines.join(os.EOL));

      throw err;
    }
  }
});


cli.init();
