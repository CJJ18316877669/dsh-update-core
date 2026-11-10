window.__ModuleLoader__.load({
  id: 'dsh-update-core-plugin',
  factory: (require) => {
    const React = require('react');
    const name = 'dsh-update-core-plugin';
    const inject = ['slots'];

    function UpdateFrame() {
      return React.createElement('iframe', {
        src: '/dsh-update/',
        title: 'DeepSeek Harness 一键更新',
        style: {
          width: '100%',
          height: 'calc(100vh - 132px)',
          minHeight: '540px',
          border: '0',
          background: 'transparent',
        },
      });
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: name,
        order: 65,
        label: () => '一键更新',
        inject: () => ({}),
      }, () => React.createElement(UpdateFrame)));
    }

    const exports = { apply, inject, name };
    return exports;
  },
});
