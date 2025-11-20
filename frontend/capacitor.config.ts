import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fit.running530.app',
  appName: 'Running 530',
  // Default: serve from remote URL to verify runtime
  webDir: 'out',
  // server: {
  //   url: 'https://running530.app',
  //   androidScheme: 'https',
  // },
  android: {
    allowMixedContent: false,
  },
};

export default config;
