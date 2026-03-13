# /auth/frontend/Dockerfile
FROM nginx:1.27-alpine

COPY ./*.html /usr/share/nginx/html/
COPY ./*.js /usr/share/nginx/html/
COPY ./*.css /usr/share/nginx/html/
COPY ./admin/ /usr/share/nginx/html/admin/

COPY ./webserver/nginx.conf /etc/nginx/nginx.conf
COPY ./webserver/auth_frontend.conf /etc/nginx/conf.d/default.conf

EXPOSE 5022

CMD ["nginx", "-g", "daemon off;"]