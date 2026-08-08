export const defaultAdapter = {
  id: 'default',
  matches() {
    return false;
  },
  cgWindowOwnerName(source) {
    return source.app;
  },
  buildBootstrapBinding(source, configuredBinding = {}) {
    return {
      ...configuredBinding,
      app: source.app,
    };
  },
  confirm: { stableSamples: 2 },
  discardUnsavedChangesOnClose: true,
};
