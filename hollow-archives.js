/**
 * hollow-archives.js
 * The Hollow Archives — Shadow Nexus Social
 * Build: HA-2026-SIMPLE-001
 *
 * Simple community horror-story library.
 * - Public visitors: browse and read published stories, search, filter by genre.
 * - Authenticated members: submit stories for founder review, check own submission status.
 * - Founder / admin: approve or reject pending submissions (server-enforced).
 *
 * Single Firestore collection: /haSubmissions/{id}
 * Status values: 'pending' | 'published' | 'rejected'
 *
 * Security contract:
 *  - Public listing queries only return status == 'published'
 *  - Authors read only their own submissions (any status)
 *  - Only founder / moderator / admin may write to the status field
 *  - No client-side role check is trusted for approval — rules enforce it
 */

(function (global) {
    'use strict';

    /* ── Firebase lazy accessors ── */
    function _f(name) {
        var fs = global._haFS;
        if (fs && typeof fs[name] === 'function') return fs[name];
        if (typeof global[name] === 'function') return global[name];
        return null;
    }
    function _col(db, ...args) { return _f('collection')(db, ...args); }
    function _doc(db, ...args) { return _f('doc')(db, ...args); }
    function _getDoc(ref)       { return _f('getDoc')(ref); }
    function _getDocs(q)        { return _f('getDocs')(q); }
    function _addDoc(ref, data) { return _f('addDoc')(ref, data); }
    function _updateDoc(ref, d) { return _f('updateDoc')(ref, d); }
    function _query(...args)    { return _f('query')(...args); }
    function _where(...args)    { return _f('where')(...args); }
    function _orderBy(...args)  { return _f('orderBy')(...args); }
    function _limit(n)          { return _f('limit')(n); }
    function _sts()             { return _f('serverTimestamp')(); }

    /* ── State ── */
    var _db   = null;
    var _auth = null;
    var _activeId  = null;   // story being read
    var _dashTab   = 'pending';
    var _genreFilter = 'all';
    var _searchTerm  = '';

    /* ═══════════════════════════════════════════════════════
       PUBLIC API — called by index.html boot script
    ═══════════════════════════════════════════════════════ */

    function init(db, auth) {
        if (_db) return;
        _db   = db;
        _auth = auth;
    }

    function open() {
        if (!_db) {
            var fbDB   = global._snxDb   || null;
            var fbAuth = global._snxAuth || null;
            if (!fbDB) { _renderErr('Archive offline. Please reload.'); return; }
            init(fbDB, fbAuth);
        }
        _showView('home');
        _renderHome();
        /* Show the Review Queue button only to moderators/founder */
        var dashBtn = document.getElementById('haOpenDashBtn');
        if (dashBtn) {
            var role = global._snxRole || '';
            var isMod = role === 'founder' || role === 'moderator' || role === 'admin';
            dashBtn.style.display = isMod ? '' : 'none';
        }
    }

    /* ═══════════════════════════════════════════════════════
       VIEW MANAGEMENT
    ═══════════════════════════════════════════════════════ */

    function _showView(id) {
        document.querySelectorAll('#hollowArchivesPage .ha-view')
            .forEach(function (v) { v.classList.remove('ha-active'); });
        var el = document.getElementById('haView_' + id);
        if (el) el.classList.add('ha-active');
        window.scrollTo(0, 0);
    }

    /* ═══════════════════════════════════════════════════════
       HOME — PUBLISHED LISTING
    ═══════════════════════════════════════════════════════ */

    function _renderHome() {
        _loadPublishedStories(_genreFilter, _searchTerm);
    }

    async function _loadPublishedStories(genre, search) {
        var listEl = document.getElementById('haStoryList');
        if (!listEl) return;
        listEl.innerHTML = _spinnerHTML();
        try {
            var constraints = [
                _where('status', '==', 'published'),
                _orderBy('publishedAt', 'desc'),
                _limit(40)
            ];
            if (genre && genre !== 'all') {
                constraints.unshift(_where('genre', '==', genre));
            }
            var snap = await _getDocs(_query(_col(_db, 'haSubmissions'), ...constraints));
            var docs = snap.docs;

            /* Client-side search filter (title / excerpt) */
            if (search) {
                var lc = search.toLowerCase();
                docs = docs.filter(function (d) {
                    var data = d.data();
                    return (data.title   || '').toLowerCase().includes(lc) ||
                           (data.excerpt || '').toLowerCase().includes(lc) ||
                           (data.authorName || '').toLowerCase().includes(lc);
                });
            }

            if (!docs.length) {
                listEl.innerHTML = _emptyHTML(search
                    ? 'No stories matched "' + _esc(search) + '".'
                    : 'No stories published yet. Be the first to submit one.');
                return;
            }
            listEl.innerHTML = docs.map(function (d) {
                return _storyCardHTML(d.id, d.data());
            }).join('');
        } catch (e) {
            listEl.innerHTML = _errHTML('Could not load stories.');
            console.error('[HA]', e);
        }
    }

    /* ═══════════════════════════════════════════════════════
       STORY READER
    ═══════════════════════════════════════════════════════ */

    async function openStory(id) {
        _activeId = id;
        _showView('reader');
        var topbar = document.getElementById('haReaderTopbar');
        var body   = document.getElementById('haReaderBody');
        if (body) body.innerHTML = _spinnerHTML();
        try {
            var snap = await _getDoc(_doc(_db, 'haSubmissions', id));
            if (!snap.exists()) { if (body) body.innerHTML = _errHTML('Story not found.'); return; }
            var d = snap.data();

            /* Access check: only published stories are public.
               Author can read own pending/rejected in "My Submissions" view, not here. */
            if (d.status !== 'published') {
                if (body) body.innerHTML = _errHTML('This story is not available.');
                return;
            }

            if (topbar) topbar.textContent = d.title || 'Story';
            if (!body) return;
            body.innerHTML =
                '<div class="ha-progress-bar"><div class="ha-progress-fill" id="haProgFill"></div></div>' +
                '<div class="ha-reader-body">' +
                  '<span class="ha-reader-label">' + _esc((d.genre || 'Horror').toUpperCase()) + '</span>' +
                  '<h1 class="ha-reader-title">' + _esc(d.title || '') + '</h1>' +
                  '<div class="ha-reader-byline">' +
                    '<span>By <strong>' + _esc(d.authorName || 'Anonymous') + '</strong></span>' +
                    '<span>·</span>' +
                    '<span>' + _relTime(d.publishedAt && d.publishedAt.toDate ? d.publishedAt.toDate() : null) + '</span>' +
                  '</div>' +
                  (d.coverImageUrl
                    ? '<img src="' + _esc(d.coverImageUrl) + '" alt="Cover" style="width:100%;max-height:280px;object-fit:cover;border-radius:8px;margin-bottom:20px;border:1px solid rgba(0,130,210,0.2);">'
                    : '') +
                  '<div class="ha-reader-divider"></div>' +
                  '<div class="ha-reader-text">' + _textToHTML(d.storyText || '') + '</div>' +
                '</div>';

            /* Reading progress bar */
            var ticking = false;
            var onScroll = function () {
                if (!ticking) {
                    requestAnimationFrame(function () {
                        var fill = document.getElementById('haProgFill');
                        if (fill) {
                            var total = document.documentElement.scrollHeight - window.innerHeight;
                            fill.style.width = total > 0 ? Math.min(100, (window.scrollY / total) * 100) + '%' : '0%';
                        }
                        ticking = false;
                    });
                    ticking = true;
                }
            };
            window.addEventListener('scroll', onScroll, { passive: true });
        } catch (e) {
            if (body) body.innerHTML = _errHTML('Failed to load story.');
            console.error('[HA] openStory', e);
        }
    }

    function _backToHome() {
        _showView('home');
        _renderHome();
    }

    /* ═══════════════════════════════════════════════════════
       SUBMISSION FORM
    ═══════════════════════════════════════════════════════ */

    function openSubmit() {
        var uid = _auth && _auth.currentUser && _auth.currentUser.uid;
        if (!uid) { _toast('Please sign in to submit a story.'); return; }
        _showView('submit');
        /* Clear form */
        ['haSubTitle','haSubExcerpt','haSubText','haSubCover'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var genreSel = document.getElementById('haSubGenre');
        if (genreSel) genreSel.value = 'horror';
        var chk = document.getElementById('haSubOwnership');
        if (chk) chk.checked = false;
        _updateCharCount();
    }

    async function _doSubmit() {
        var uid = _auth && _auth.currentUser && _auth.currentUser.uid;
        if (!uid) { _toast('Please sign in first.'); return; }

        var title    = (document.getElementById('haSubTitle')    ?.value || '').trim();
        var excerpt  = (document.getElementById('haSubExcerpt')  ?.value || '').trim();
        var text     = (document.getElementById('haSubText')     ?.value || '').trim();
        var genre    = document.getElementById('haSubGenre')      ?.value || 'horror';
        var coverUrl = (document.getElementById('haSubCover')    ?.value || '').trim();
        var owned    = document.getElementById('haSubOwnership') ?.checked;

        if (!title)  { _toast('Please enter a title.'); return; }
        if (title.length > 120) { _toast('Title must be under 120 characters.'); return; }
        if (!text)   { _toast('Please enter your story text.'); return; }
        if (text.length < 100) { _toast('Story must be at least 100 characters.'); return; }
        if (text.length > 40000) { _toast('Story exceeds the 40,000 character limit.'); return; }
        if (!owned)  { _toast('You must confirm ownership or permission to submit.'); return; }

        /* Validate cover URL if provided */
        if (coverUrl) {
            try { new URL(coverUrl); } catch (_) { _toast('Cover image must be a valid URL.'); return; }
            if (!/^https?:\/\//i.test(coverUrl)) { _toast('Cover image URL must start with https://.'); return; }
        }

        try {
            var userSnap = await _getDoc(_doc(_db, 'users', uid));
            var ud = userSnap.exists() ? userSnap.data() : {};

            await _addDoc(_col(_db, 'haSubmissions'), {
                title,
                excerpt:       excerpt || text.slice(0, 200).trimEnd(),
                storyText:     text,
                genre,
                coverImageUrl: coverUrl || '',
                authorUid:     uid,
                authorName:    ud.displayName || 'Anonymous',
                authorHandle:  ud.username    || '',
                status:        'pending',
                ownershipConfirmed: true,
                submittedAt:   _sts(),
                publishedAt:   null,
                reviewedAt:    null,
                reviewedBy:    null,
                reviewFeedback:''
            });

            _toast('✅ Story submitted! Awaiting founder review.');
            _showView('home');
            _renderHome();
        } catch (e) {
            _toast('Submission failed. Please try again.');
            console.error('[HA] _doSubmit', e);
        }
    }

    function _updateCharCount() {
        var el    = document.getElementById('haSubText');
        var count = document.getElementById('haSubCharCount');
        if (!el || !count) return;
        var len = el.value.length;
        var max = 40000;
        count.textContent = len + ' / ' + max.toLocaleString();
        count.className = 'ha-char-count' +
            (len > max ? ' over' : len > max * 0.9 ? ' warn' : '');
    }

    /* ═══════════════════════════════════════════════════════
       MY SUBMISSIONS — author status check
    ═══════════════════════════════════════════════════════ */

    async function openMySubmissions() {
        var uid = _auth && _auth.currentUser && _auth.currentUser.uid;
        if (!uid) { _toast('Please sign in to view your submissions.'); return; }
        _showView('mySubmissions');
        var body = document.getElementById('haMySubBody');
        if (body) body.innerHTML = _spinnerHTML();
        try {
            var q = _query(
                _col(_db, 'haSubmissions'),
                _where('authorUid', '==', uid),
                _orderBy('submittedAt', 'desc'),
                _limit(30)
            );
            var snap = await _getDocs(q);
            if (!body) return;
            if (snap.empty) {
                body.innerHTML = _emptyHTML("You haven't submitted any stories yet.");
                return;
            }
            body.innerHTML = snap.docs.map(function (d) {
                var s = d.data();
                var feedback = s.reviewFeedback
                    ? '<div class="ha-status-feedback">Founder note: ' + _esc(s.reviewFeedback) + '</div>'
                    : '';
                var dateStr = s.submittedAt && s.submittedAt.toDate
                    ? _relTime(s.submittedAt.toDate()) : '';
                return '<div class="ha-status-card ' + (s.status || '') + '">' +
                    '<div class="ha-status-title">' + _esc(s.title || 'Untitled') + '</div>' +
                    '<div class="ha-status-meta">' +
                      '<span class="ha-status-badge ' + (s.status || '') + '">' + (s.status || '').toUpperCase() + '</span>' +
                      '<span>' + _esc(s.genre || '') + '</span>' +
                      (dateStr ? '<span>Submitted ' + dateStr + '</span>' : '') +
                    '</div>' +
                    feedback +
                    (s.status === 'published'
                        ? '<button onclick="HollowArchives.openStory(\'' + d.id + '\')" style="font-size:11px;padding:5px 12px;border-radius:6px;background:rgba(0,174,239,0.08);border:1px solid rgba(0,174,239,0.4);color:#007fbb;margin-top:6px;">Read →</button>'
                        : '') +
                    '</div>';
            }).join('');
        } catch (e) {
            if (body) body.innerHTML = _errHTML('Could not load your submissions.');
            console.error('[HA] openMySubmissions', e);
        }
    }

    /* ═══════════════════════════════════════════════════════
       FOUNDER DASHBOARD
    ═══════════════════════════════════════════════════════ */

    function openDashboard() {
        var role = global._snxRole || '';
        var isMod = role === 'founder' || role === 'moderator' || role === 'admin';
        if (!isMod) {
            _toast('Founder access required.');
            return;
        }
        _showView('dashboard');
        _loadDash(_dashTab);
    }

    async function _loadDash(tab) {
        _dashTab = tab;
        /* Update active tab UI */
        document.querySelectorAll('.ha-dash-tab').forEach(function (btn) {
            btn.classList.toggle('ha-tab-active', btn.dataset.tab === tab);
        });
        var body = document.getElementById('haDashBody');
        if (body) body.innerHTML = _spinnerHTML();
        try {
            var statusFilter = tab === 'history'
                ? ['published', 'rejected']
                : ['pending'];

            var constraints = [
                _where('status', 'in', statusFilter),
                _orderBy('submittedAt', 'desc'),
                _limit(50)
            ];
            var snap = await _getDocs(_query(_col(_db, 'haSubmissions'), ...constraints));
            if (!body) return;
            if (snap.empty) {
                body.innerHTML = _emptyHTML(tab === 'history' ? 'No reviewed submissions yet.' : 'No pending submissions. The queue is clear.');
                return;
            }
            body.innerHTML = snap.docs.map(function (d) {
                return _dashCardHTML(d.id, d.data());
            }).join('');
        } catch (e) {
            if (body) body.innerHTML = _errHTML('Failed to load dashboard.');
            console.error('[HA] _loadDash', e);
        }
    }

    function _dashCardHTML(id, s) {
        var isPending = s.status === 'pending';
        var preview   = _esc((s.storyText || '').slice(0, 600));
        var meta      = [
            s.genre || '',
            s.authorName ? 'By ' + s.authorName : '',
            s.submittedAt && s.submittedAt.toDate ? 'Submitted ' + _relTime(s.submittedAt.toDate()) : ''
        ].filter(Boolean).join(' · ');

        var actions = isPending
            ? '<input type="text" id="haFeedback_' + id + '" class="ha-feedback-input" placeholder="Optional feedback to author…" maxlength="300">' +
              '<button class="ha-btn-approve" onclick="HollowArchives._approve(\'' + id + '\')">Approve</button>' +
              '<button class="ha-btn-reject"  onclick="HollowArchives._reject(\''  + id + '\')">Reject</button>'
            : '<span class="ha-status-badge ' + s.status + '">' + (s.status || '').toUpperCase() + '</span>' +
              (s.reviewFeedback ? ' <em style="font-size:11px;color:var(--ha-t3)">' + _esc(s.reviewFeedback) + '</em>' : '');

        return '<div class="ha-dash-card" id="haCard_' + id + '">' +
            '<div class="ha-dash-card-title">' + _esc(s.title || 'Untitled') + '</div>' +
            '<div class="ha-dash-card-meta">' + meta + '</div>' +
            (s.coverImageUrl
                ? '<img src="' + _esc(s.coverImageUrl) + '" alt="" style="width:100%;max-height:160px;object-fit:cover;border-radius:6px;margin-bottom:10px;border:1px solid rgba(0,130,210,0.2);">'
                : '') +
            '<div class="ha-dash-card-preview" id="haPreview_' + id + '">' + preview + '</div>' +
            '<button class="ha-expand-btn" onclick="HollowArchives._expandPreview(\'' + id + '\')">Show full text ▼</button>' +
            '<div class="ha-dash-actions">' + actions + '</div>' +
            '</div>';
    }

    function _expandPreview(id) {
        var el  = document.getElementById('haPreview_' + id);
        var btn = el && el.nextElementSibling;
        if (!el) return;
        el.classList.toggle('ha-expanded');
        if (btn) btn.textContent = el.classList.contains('ha-expanded') ? 'Collapse ▲' : 'Show full text ▼';
    }

    async function _approve(id) {
        await _review(id, 'published');
    }

    async function _reject(id) {
        await _review(id, 'rejected');
    }

    async function _review(id, newStatus) {
        var uid  = _auth && _auth.currentUser && _auth.currentUser.uid;
        var role = global._snxRole || '';
        var isMod = role === 'founder' || role === 'moderator' || role === 'admin';
        if (!uid || !isMod) { _toast('Not authorised.'); return; }

        /* Client-side self-approval guard.
           The Firestore rule enforces this server-side too, but we check here to
           give a clear message rather than a raw permission-denied error. */
        try {
            var ownSnap = await _getDoc(_doc(_db, 'haSubmissions', id));
            if (ownSnap.exists() && ownSnap.data().authorUid === uid) {
                _toast('⛔ You cannot approve or reject your own submission.');
                return;
            }
        } catch (_) { /* if fetch fails, let the server rule block it */ }

        var feedbackEl = document.getElementById('haFeedback_' + id);
        var feedback   = (feedbackEl ? feedbackEl.value : '').trim().slice(0, 300);

        try {
            var payload = {
                status:         newStatus,
                reviewedBy:     uid,
                reviewedAt:     _sts(),
                reviewFeedback: feedback
            };
            if (newStatus === 'published') payload.publishedAt = _sts();

            /* Firestore rule enforces: only moderators/founder may write status,
               and the author cannot change their own submission's status.
               If the caller is not a moderator the write will throw permission-denied. */
            await _updateDoc(_doc(_db, 'haSubmissions', id), payload);

            /* Remove card from pending view */
            var card = document.getElementById('haCard_' + id);
            if (card) {
                card.style.opacity = '0.4';
                card.style.pointerEvents = 'none';
                card.querySelector('.ha-dash-actions').innerHTML =
                    '<span class="ha-status-badge ' + newStatus + '">' + newStatus.toUpperCase() + '</span>';
            }
            _toast(newStatus === 'published' ? '✅ Story published.' : '🗂 Story rejected.');
        } catch (e) {
            if (e.code === 'permission-denied') {
                _toast('⛔ Permission denied — server rejected this action.');
            } else {
                _toast('Action failed. Please try again.');
            }
            console.error('[HA] _review error code=' + (e.code || 'unknown') + ' msg=' + (e.message || e), e);
        }
    }

    /* ═══════════════════════════════════════════════════════
       SEARCH / FILTER
    ═══════════════════════════════════════════════════════ */

    function _onSearchKey(e) {
        if (e.key === 'Enter') _runSearch();
    }

    function _runSearch() {
        _searchTerm = (document.getElementById('haSearchInput')?.value || '').trim();
        /* Genre filter pill stays as-is */
        _loadPublishedStories(_genreFilter, _searchTerm);
    }

    function _setGenre(genre) {
        _genreFilter = genre;
        document.querySelectorAll('#hollowArchivesPage .ha-pill').forEach(function (p) {
            p.classList.toggle('ha-active', p.dataset.genre === genre);
        });
        _loadPublishedStories(_genreFilter, _searchTerm);
    }

    /* ═══════════════════════════════════════════════════════
       HTML HELPERS
    ═══════════════════════════════════════════════════════ */

    function _storyCardHTML(id, s) {
        var emoji = { horror:'🩸', supernatural:'👁', thriller:'🔦', mystery:'🕵', paranormal:'👻', other:'📄' };
        var icon  = emoji[s.genre] || '📄';
        var genreClass = (s.genre || 'other').replace(/[^a-z]/gi, '');
        return '<div class="ha-story-card" onclick="HollowArchives.openStory(\'' + id + '\')">' +
            '<div class="ha-story-cover">' + icon + '</div>' +
            '<div class="ha-story-info">' +
              '<div class="ha-story-title">' + _esc(s.title || 'Untitled') + '</div>' +
              '<div class="ha-story-meta">' +
                '<span>By ' + _esc(s.authorName || 'Anonymous') + '</span>' +
                '<span><span class="ha-genre-tag ' + genreClass + '">' + _esc(s.genre || 'other') + '</span></span>' +
                (s.publishedAt && s.publishedAt.toDate ? '<span>' + _relTime(s.publishedAt.toDate()) + '</span>' : '') +
              '</div>' +
              '<div class="ha-story-excerpt">' + _esc(s.excerpt || (s.storyText || '').slice(0, 160)) + '</div>' +
            '</div>' +
            '</div>';
    }

    function _textToHTML(raw) {
        return raw.split(/\n\n+/).map(function (p) {
            return '<p>' + _esc(p).replace(/\n/g, '<br>') + '</p>';
        }).join('');
    }

    function _esc(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function _relTime(date) {
        if (!date) return '';
        var diff = Date.now() - date.getTime();
        if (diff < 60000)      return 'just now';
        if (diff < 3600000)    return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000)   return Math.floor(diff / 3600000) + 'h ago';
        if (diff < 2592000000) return Math.floor(diff / 86400000) + 'd ago';
        return date.toLocaleDateString();
    }

    function _spinnerHTML() {
        return '<div class="ha-spinner-wrap"><div class="ha-spinner"></div>Loading…</div>';
    }
    function _emptyHTML(msg) {
        return '<div class="ha-empty"><div class="ha-empty-icon">📂</div><div class="ha-empty-text">' + _esc(msg) + '</div></div>';
    }
    function _errHTML(msg) {
        return '<div class="ha-error-text">⚠ ' + _esc(msg) + '</div>';
    }
    function _renderErr(msg) {
        var pg = document.getElementById('hollowArchivesPage');
        if (pg) pg.innerHTML = _errHTML(msg);
    }

    var _toastTimer;
    function _toast(msg) {
        var el = document.getElementById('haToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'haToast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('ha-show');
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function () { el.classList.remove('ha-show'); }, 3200);
    }

    /* ═══════════════════════════════════════════════════════
       PUBLIC API
    ═══════════════════════════════════════════════════════ */

    global.HollowArchives = {
        init,
        open,
        openStory,
        openSubmit,
        openMySubmissions,
        openDashboard,
        /* internal — called by inline onclick */
        _backToHome,
        _runSearch,
        _onSearchKey,
        _setGenre,
        _doSubmit,
        _updateCharCount,
        _loadDash,
        _expandPreview,
        _approve,
        _reject
    };

})(window);
