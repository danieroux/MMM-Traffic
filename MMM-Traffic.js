/* Magic Mirror
 * Module: MMM-Traffic
 *
 * By Sam Lewis https://github.com/SamLewis0602
 * MIT Licensed.
 */

Module.register('MMM-Traffic', {
  defaults: {
    interval: 300000,
    showSymbol: true,
    firstLine: 'Current duration is {duration} mins',
    loadingText: 'Loading...',
    language: config.language,
    mode: 'driving',
    days: [0, 1, 2, 3, 4, 5, 6],
    hoursStart: '00:00',
    hoursEnd: '23:59',
    waypoints: [],
    useCalendar: false,
  },

  start: function () {
    console.log('Starting module: ' + this.name);
    this.loading = true;
    this.internalHidden = false;
    this.firstResume = true;
    this.errorMessage = undefined;
    this.errorDescription = undefined;
    this.calendarEvent = null;
    this.calendarDestCoords = null;
    this.updateCommute = this.updateCommute.bind(this);
    this.getCommute = this.getCommute.bind(this);
    this.getDom = this.getDom.bind(this);
    this._geocodeTimer = null;

    if (
      [this.config.originCoords, this.config.accessToken].includes(undefined)
    ) {
      this.errorMessage = 'Config error';
      this.errorDescription =
        'You must set originCoords and accessToken in your config';
      this.updateDom();
      return;
    }

    if (!this.config.useCalendar) {
      if (this.config.destinationCoords === undefined) {
        this.errorMessage = 'Config error';
        this.errorDescription =
          'You must set destinationCoords when useCalendar is false';
        this.updateDom();
        return;
      }
      this.updateCommute();
    }
  },

  notificationReceived: function (notification, payload) {
    if (!this.config.useCalendar) return;
    if (notification !== 'CALENDAR_EVENTS') return;

    const now = Date.now() / 1000; // CALENDAR_EVENTS startDate is in seconds
    const next =
      payload
        .filter((e) => (e.location || e.geo) && e.startDate > now)
        .sort((a, b) => a.startDate - b.startDate)[0] || null;

    if (!next) {
      // Only clear if the current event is no longer in the future
      if (!this.calendarEvent || this.calendarEvent.startDate <= now) {
        this.calendarEvent = null;
        this.calendarDestCoords = null;
        this.updateDom();
      }
      return;
    }

    // Keep the current event if it's still in the future and starts sooner
    if (
      this.calendarEvent &&
      this.calendarEvent.startDate > now &&
      this.calendarEvent.startDate <= next.startDate
    ) {
      return;
    }

    // Only re-resolve when the destination actually changes
    if (
      !this.calendarEvent ||
      this.calendarEvent.location !== next.location ||
      this.calendarEvent.geo !== next.geo
    ) {
      this.calendarDestCoords = null;
      if (next.geo) {
        this.useGeoForDestCoordsAndUpdate(next);
      } else {
        this.geocodeLocationForDestCoordsAndUpdate(next);
      }
    } else {
      this.calendarEvent = next;
    }
  },

  // iCal GEO is "lat;lon"; Mapbox expects "lng,lat"
  geoToCoords: function (geo) {
    if (typeof geo === 'string') {
      const [lat, lon] = geo.split(';').map(Number);
      return `${lon},${lat}`;
    }
    return `${geo.lon},${geo.lat}`;
  },

  useGeoForDestCoordsAndUpdate: function (event) {
    this.calendarEvent = event;
    this.calendarDestCoords = this.geoToCoords(event.geo);
    this.updateCommute();
  },

  geocodeLocationForDestCoordsAndUpdate: function (event) {
    clearTimeout(this._geocodeTimer);
    // debounce with 1s to let the latest-latest event win
    this._geocodeTimer = setTimeout(() => {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(event.location)}.json?access_token=${this.config.accessToken}&limit=1`;
      fetch(url)
        .then((res) => res.json())
        .then((json) => {
          if (json.features && json.features.length > 0) {
            const [lng, lat] = json.features[0].center;
            this.calendarEvent = event;
            this.calendarDestCoords = `${lng},${lat}`;
            this.updateCommute();
          }
        })
        .catch((e) => {
          this.errorMessage = 'Geocoding error';
          this.errorDescription = e.message;
          this.updateDom();
        });
    }, 1000);
  },

  updateCommute: function () {
    const destCoords = this.config.useCalendar
      ? this.calendarDestCoords
      : this.config.destinationCoords;

    if (!destCoords) return;

    let mode =
      this.config.mode == 'driving' ? 'driving-traffic' : this.config.mode;

    // Build coordinates string with optional waypoints
    let coordinates = this.config.originCoords;
    if (this.config.waypoints && this.config.waypoints.length > 0) {
      coordinates += ';' + this.config.waypoints.join(';');
    }
    coordinates += ';' + destCoords;

    this.url = encodeURI(
      `https://api.mapbox.com/directions/v5/mapbox/${mode}/${coordinates}?access_token=${this.config.accessToken}`,
    );

    // only run getDom once at the start of a hidden period to remove the module from the screen, then just wait until time to unhide to run again
    if (this.shouldHide() && !this.internalHidden) {
      console.log(
        'Hiding MMM-Traffic due to config options: days, hoursStart, hoursEnd',
      );
      this.internalHidden = true;
      this.updateDom();
    } else if (!this.shouldHide()) {
      this.internalHidden = false;
      this.getCommute(this.url);
    }
    // no network requests are made when the module is hidden, so check every 30 seconds during hidden
    // period to see if it's time to unhide yet
    clearTimeout(this._updateTimer);
    this._updateTimer = setTimeout(
      this.updateCommute,
      this.internalHidden ? 3000 : this.config.interval,
    );
  },

  getCommute: function (api_url) {
    var self = this;
    fetch(api_url)
      .then((res) => {
        if (!res.ok) {
          return res.json().then((json) => {
            throw new Error(
              json.message || `API Error - ${res.status} ${res.statusText}`,
            );
          });
        }
        return res.json();
      })
      .then((json) => {
        self.duration = Math.round(json.routes[0].duration / 60);
        self.hours = Math.floor(self.duration / 60);
        self.leftoverMinutes = self.duration % 60;
        self.route = json.routes[0].legs[0].summary;
        self.errorMessage = self.errorDescription = undefined;
        self.loading = false;
        self.updateDom();
      })
      .catch((e) => {
        self.errorMessage = 'Error fetching commute';
        self.errorDescription = e.message;
        self.loading = false;
        self.updateDom();
      });
  },

  getStyles: function () {
    return ['traffic.css', 'font-awesome.css'];
  },

  getScripts: function () {
    return ['moment.js'];
  },

  getDom: function () {
    var wrapper = document.createElement('div');

    // hide when desired (called once on first update during hidden period)
    if (this.internalHidden) return wrapper;

    // base divs
    // In calendar mode, show nothing when there's no upcoming event with a location
    if (this.config.useCalendar && !this.calendarEvent) return wrapper;

    var firstLineDiv = document.createElement('div');
    firstLineDiv.className = 'bright medium mmmtraffic-firstline';
    var secondLineDiv = document.createElement('div');
    secondLineDiv.className = 'normal small mmmtraffic-secondline';

    // display any errors
    if (this.errorMessage) {
      firstLineDiv.innerHTML = this.errorMessage;
      secondLineDiv.innerHTML = this.errorDescription;
      wrapper.append(firstLineDiv);
      wrapper.append(secondLineDiv);
      return wrapper;
    }

    let symbolString = 'car';
    if (this.config.mode == 'cycling') symbolString = 'bicycle';
    if (this.config.mode == 'walking') symbolString = 'walking';

    // symbol
    if (this.config.showSymbol) {
      var symbol = document.createElement('span');
      symbol.className = `fa fa-${symbolString} symbol`;
      firstLineDiv.appendChild(symbol);
    }

    // first line
    var firstLineText = document.createElement('span');
    firstLineText.innerHTML = this.loading
      ? this.config.loadingText
      : this.replaceTokens(this.config.firstLine);
    firstLineDiv.appendChild(firstLineText);
    wrapper.appendChild(firstLineDiv);
    if (this.loading) return wrapper;

    // second line
    if (this.config.secondLine) {
      secondLineDiv.innerHTML = this.replaceTokens(this.config.secondLine);
      wrapper.appendChild(secondLineDiv);
    }

    return wrapper;
  },

  replaceTokens: function (text) {
    return text
      .replace(/{duration}/g, this.duration)
      .replace(/{hours}/g, this.hours)
      .replace(/{leftoverMinutes}/g, this.leftoverMinutes)
      .replace(/{route}/g, this.route)
      .replace(
        /{eventTitle}/g,
        this.calendarEvent ? this.calendarEvent.title : '',
      );
  },

  shouldHide: function () {
    let hide = true;
    let now = moment();
    if (
      this.config.days.includes(now.day()) &&
      moment(this.config.hoursStart, 'HH:mm').isBefore(now) &&
      moment(this.config.hoursEnd, 'HH:mm').isAfter(now)
    ) {
      hide = false;
    }
    return hide;
  },
});
