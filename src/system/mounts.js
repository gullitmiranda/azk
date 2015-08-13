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
    sync_base_path = path.join(sync_base_path, this.manifest.namespace, this.system.name);
    return path.join(sync_base_path, this._resolved_path(mount_path));
  }

  /* Volumes */
  _to_volume(mount, daemon, valid_mounts) {
    if (_.isString(mount)) {
      mount = { type: 'path', target: mount };
    } else {
      mount = _.clone(mount);
      mount.target = mount.value;
    }
    var target = mount.target;

    switch (mount.type) {
      case 'path':
        if (!target.match(/^\//)) {
          target = this._resolved_path(target);
        }
        mount.base = target;
        target = this._host_resolve(target, valid_mounts);

        break;
      case 'persistent':
        // persistent folder
        var persist_base = config('paths:persistent_folders');
        persist_base = path.join(persist_base, this.manifest.namespace);
        target = path.join(persist_base, target);
        mount.base = target;
        break;

      case 'sync':
        if (daemon && mount.options.daemon !== false ||
           !daemon && mount.options.shell === true) {
          target = this._sync_path(target);
        } else {
          if (!target.match(/^\//)) {
            target = this._resolved_path(target);
          }
          mount.base = target;
          target = this._host_resolve(target, valid_mounts);
        }
        break;
    }
    mount.target = target;
    return mount;
  }

  _host_resolve(target, valid_mounts = true) {
    if (fs.existsSync(target)) {
      target = utils.docker.resolvePath(target);
    } else {
      target = valid_mounts ? null : target;
    }
    return target;
  }

  volumes(mounts, daemon = true, valid_mounts = true) {
    var volumes = {};

    return _.reduce(mounts, (volumes, mount, point) => {
      var target = this._to_volume(mount, daemon, valid_mounts).target;
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

  getRemotes() {
    if (!this.system.pull_remote) {
      return promiseResolve();
    }

    var mounts  = this.system.remote_mounts || {};
    var topic   = "system.mounts.get_remote.status";

    var publish_data = {
      type  : "remote_mounts",
      system: this.system.name,
    };

    return thenAll(_.map(mounts, (mount_data) => {
      var promise = promiseResolve();
      var target  = mount_data.base;

      // Download external file
      if (this.system.pull_remote || !fs.existsSync(target)) {
        var origin = mount_data.options.from;

        publish(topic, _.merge(publish_data, {
          origin  : origin,
          target  : target,
          filename: mount_data.value,
          mount   : mount_data
        }));
        log.debug('[mounts][get_file] download %s => %s', origin, target);

        promise = this._getRemote(origin, target);
      }
      return promise;
    }))
    .then(() => {
      this.system.pull_remote = false;
    });
  }

  _getRemote(url, output) {
    var manifest = new lazy.Manifest(config('paths:shared'), true);
    var system = manifest.system("base", true);

    var base_path = path.dirname(output);

    var persist_base = config('paths:persistent_folders');
    system.options.mounts = system.options.mounts || {};
    system.options.mounts[persist_base] = persist_base;
    system.options.mounts[base_path   ] = base_path;

    var command = ["curl", "-sS", "-o", output, url];
    return lazy.Server.runCommand(command, system);
  }
}
