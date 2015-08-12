import { _, config, log, fs, utils, lazy_require, path } from 'azk';
import { publish } from 'azk/utils/postal';
import { promiseResolve, thenAll } from 'azk/utils/promises';

var lazy = lazy_require({
  Manifest: ['azk/manifest'],
  Server: ['azk/agent/server'],
});

export class Mounts {
  constructor(system) {
    this.system   = system;
    this.manifest = system.manifest;
    return this;
  }

  /* Path resolvers */
  _resolved_path(mount_path) {
    if (!mount_path) {
      return this.manifest.manifestPath;
    }
    return path.resolve(this.manifest.manifestPath, mount_path);
  }

  _sync_path(mount_path) {
    var sync_base_path = config('paths:sync_folders');
    sync_base_path = path.join(sync_base_path, this.manifest.namespace, this.name);
    return path.join(sync_base_path, this._resolved_path(mount_path));
  }

  /* Volumes */
  _to_volume(mount, daemon) {
    if (_.isString(mount)) {
      mount = { type: 'path', target: mount };
    } else {
      mount = _.clone(mount);
      mount.target = mount.value;
      delete(mount.value);
    }
    var target = mount.target;

    switch (mount.type) {
      case 'path':
        if (!target.match(/^\//)) {
          target = this._resolved_path(target);
        }
        break;
      case 'persistent':
        // persistent folder
        var persist_base = config('paths:persistent_folders');
        persist_base = path.join(persist_base, this.manifest.namespace);
        target = path.join(persist_base, target);
        break;

      case 'sync':
        if (daemon && mount.options.daemon !== false ||
           !daemon && mount.options.shell === true) {
          target = this._sync_path(target);
        } else {
          if (!target.match(/^\//)) {
            target = this._resolved_path(target);
          }
        }
        break;
    }
    mount.target = target;
    return mount;
  }

  volumes(mounts, daemon = true) {
    var volumes = {};

    return _.reduce(mounts, (volumes, mount, point) => {
      var target = this._to_volume(mount, daemon).target;

      if (_.include(["path", "sync"], mount.type)) {
        if (fs.existsSync(target)) {
          target = utils.docker.resolvePath(target);
        } else {
          log.warn('[mounts] path does not exist:', target);
          target = null;
        }
      }

      if (!_.isEmpty(target)) {
        volumes[point] = target;
      }

      return volumes;
    }, volumes);
  }

  syncs(mounts) {
    var syncs = {};

    return _.reduce(mounts, (syncs, mount, mount_key) => {
      if (mount.type === 'sync') {

        var host_sync_path = this._resolved_path(mount.value);

        var mounted_subpaths = _.reduce(mounts, (subpaths, mount, dir) => {
          if ( dir !== mount_key && dir.indexOf(mount_key) === 0) {
            var regex = new RegExp(`^${mount_key}`);
            subpaths = subpaths.concat([path.normalize(dir.replace(regex, './'))]);
          }
          return subpaths;
        }, []);

        mount.options        = mount.options || {};
        mount.options.except = _.uniq(_.flatten([mount.options.except || []])
          .concat(mounted_subpaths)
          .concat(['.syncignore', '.gitignore', '.azk/', '.git/', 'Azkfile.js']));

        syncs[host_sync_path] = {
          guest_folder: this._sync_path(mount.value),
          options     : mount.options,
        };
      }
      return syncs;
    }, syncs);
  }

  remotes(mounts) {
    return _.reduce(mounts, (externals, mount, mount_key) => {
      if (_.isObject(mount) && _.has(mount.options, "from") && !_.isNull(mount.options.from)) {
        externals[mount_key] = this._to_volume(mount);
      }
      return externals;
    }, {});
  }

  getRemotes(options = {}) {
    var topic   = "system.mounts.external.status";
    var promise = promiseResolve();

    publish(topic, { type : "mounts", system : this.system.name });

    return thenAll(_.map(this.system.remote_mounts || {}, (mount_data/*, mount_origin*/) => {
      var target = mount_data.target;
      var force  = (options.provision_force || options.build_force);

      // Download external file
      if (force || !fs.existsSync(target)) {
        promise = this._getRemote(mount_data.options.from, target, force);
      }
      return promise;
    }));
  }

  _getRemote(url, output) {
    var manifest = new lazy.Manifest(config('paths:shared'), true);
    var system = manifest.system("base", true);

    var persist_base = config('paths:persistent_folders');
    system.options.mounts = system.options.mounts || {};
    system.options.mounts[persist_base] = persist_base;

    var command = ["curl", "-sS", "-o", output, url];
    return lazy.Server.runCommand(command, system);
  }
}
