const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withIosBuild(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');
      const marker = 'Wno-error=incomplete-umbrella';
      if (!contents.includes(marker)) {
        const snippet = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |cfg|
        cfg.build_settings['GCC_TREAT_WARNINGS_AS_ERRORS'] = 'NO'
        cfg.build_settings['OTHER_CFLAGS'] = '$(inherited) -Wno-error=incomplete-umbrella -Wno-incomplete-umbrella'
      end
    end
`;
        contents = contents.replace('post_install do |installer|', `post_install do |installer|${snippet}`);
        fs.writeFileSync(podfilePath, contents);
      }
      return config;
    },
  ]);
}

module.exports = withIosBuild;
