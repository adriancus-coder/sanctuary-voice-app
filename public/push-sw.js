self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  const title = data.title || 'Sanctuary Voice';
  const options = {
    body: data.body || 'Traducerea este live.',
    data: {
      url: data.url || '/participant'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/participant';
  event.waitUntil(clients.openWindow(url));
});
