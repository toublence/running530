import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fit.running530.app',
  appName: 'Running 530',
  webDir: 'frontend/out',
  android: {
    allowMixedContent: false,
  },
  // @ts-ignore
  ios: {
    contentInset: 'automatic',
    allowsLinkPreview: false,
    preferredContentMode: 'mobile',
    scheme: 'https'
  }

};

export default config;
