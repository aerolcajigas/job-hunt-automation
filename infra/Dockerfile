# user-web: jobs.example.com (private JobHunt dashboard) + portfolio.example.com (public portfolio).
# Built ON THE VPS by JobHunt/infra/setup.mjs (step "web").
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY jobhunt.htpasswd /etc/nginx/jobhunt.htpasswd
COPY jobs/ /usr/share/nginx/jobs/
COPY portfolio/ /usr/share/nginx/portfolio/
