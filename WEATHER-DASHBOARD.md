# Weather Dashboard

A visitor-facing weather dashboard is available at `/weather.html`. It fetches current conditions and a seven-day forecast from the public Open-Meteo Forecast API and uses Open-Meteo Geocoding API for city search. No API key is required. The page supports browser geolocation (with user permission), hourly forecast, precipitation chance, and general running-weather tips.

External weather requests are made from the visitor's browser. The dashboard needs an internet connection and can be affected by API availability or rate limits. Weather tips are general guidance, not official severe-weather alerts. Geolocation works only on localhost or a secure HTTPS origin and only with the visitor's permission.
