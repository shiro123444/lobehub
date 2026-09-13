import { getSingletonAnalyticsOptional } from '@lobehub/analytics';

interface TrackLoginOrSignupClickedParams {
  provider?: string;
  spm: string;
}

export const trackLoginOrSignupClicked = ({ provider, spm }: TrackLoginOrSignupClickedParams) => {
  const analytics = getSingletonAnalyticsOptional();
  if (!analytics) return Promise.resolve();

  const sendEvent = async () => {
    const status = analytics.getStatus();

    if (!status.initialized) {
      await analytics.initialize();
    }

    await analytics.track({
      name: 'login_or_signup_clicked',
      properties: {
        ...(provider && { provider }),
        spm,
      },
    });
  };

  // Optional analytics must never delay authentication or navigation.
  void sendEvent().catch((error) => {
    console.error('Failed to track login_or_signup_clicked:', error);
  });
  return Promise.resolve();
};
