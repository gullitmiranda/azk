import { CliTrackerController } from 'azk/cli/cli_tracker_controller.js';
import { Helpers } from 'azk/cli/helpers';
import { config, lazy_require, log, _ } from 'azk';
import { async, asyncUnsubscribe, defer } from 'azk/utils/promises';
import { subscribe } from 'azk/utils/postal';
import { AzkError } from 'azk/utils/errors';

var lazy = lazy_require({
  VM    : ['azk/agent/vm'],
  Server: ['azk/agent/server'],
  Client: ['azk/agent/client'],
});

class VMCmdError extends AzkError {
  constructor(...args) {
    super(...args);
    this.base_translation_key = '';
  }
}

export default class VM extends CliTrackerController {
  require_installed(vm_info) {
    if (!vm_info.installed) {
      throw new VMCmdError("commands.vm.not_installed");
    }
  }

  require_running(vm_info) {
    this.require_installed(vm_info);
    log.info('[vm] vm is running: %s', vm_info.running);
    if (!vm_info.running) {
      throw new VMCmdError("commands.vm.not_running");
    }
  }

  index(options = {}) {
    if (!config('agent:requires_vm')) {
      throw new VMCmdError("commands.vm.not_required");
    }

    var _subscription = subscribe('vm.action.status', (data) => {
      Helpers.vmStartProgress(this.ui)(data);
    });

    return asyncUnsubscribe(this, _subscription, function* () {
      var action  = _.head((this.route && this.route.actions)) || options.action;
      var vm_name = config("agent:vm:name");
      var vm_info = yield lazy.VM.info(vm_name);

      return this[`action_${action}`](vm_info, options);
    });
  }

  action_ssh(vm_info, params) {
    return async(this, function* () {
      this.require_running(vm_info);
      yield Helpers.requireAgent(this.ui);

      var cmd = ["ssh"];
      cmd.push('-i', config('agent:vm:ssh_key'));
      cmd.push('-o', "StrictHostKeyChecking=no");
      cmd.push('-o', "LogLevel=quiet");
      cmd.push('-o', "UserKnownHostsFile=/dev/null");
      cmd.push(`${config('agent:vm:user')}@${config('agent:vm:ip')}`);

      if (params.tty && this.ui.isInteractive()) {
        cmd.push('-t');
      } else if (params['no-tty']) {
        cmd.push('-T');
      }

      var args = _.map((params['ssh-args'] || []), (arg) => {
        return arg
          .replace(/(\\)/g, '\\\\\\')
          .replace(/([\s'"\\])/g, '\\$1')
          .replace(/([`])/g, "\\\\\\$1");
      });
      cmd.push("--", `"${args.join('" "')}"`);

      cmd = cmd.join(' ');
      log.debug("vm ssh command:", cmd);
      return this.ui.execSh(cmd);
    });
  }

  action_start(vm_info/*, _opts*/) {
    return async(this, function* () {
      if (vm_info.running) {
        throw new VMCmdError("commands.vm.already_running");
      }
      this.require_installed(vm_info);
      yield lazy.Server.installVM(true, false);
    });
  }

  action_stop(vm_info, opts) {
    return async(this, function* () {
      this.require_running(vm_info);
      yield lazy.VM.stop(vm_info.name, opts.force);
    });
  }

  action_status(vm_info) {
    return defer(() => {
      this.require_running(vm_info);
      this.ui.ok("commands.vm.running");
      return 0;
    });
  }

  action_installed(vm_info) {
    return defer(() => {
      this.require_installed(vm_info);
      this.ui.ok("commands.vm.already_installed");
      return 0;
    });
  }

  action_remove(vm_info, opts) {
    return async(this, function* () {
      this.require_installed(vm_info);
      if (vm_info.running) {
        yield lazy.VM.stop(vm_info.name, opts.force);
      }
      yield lazy.VM.remove(vm_info.name);
    });
  }
}
