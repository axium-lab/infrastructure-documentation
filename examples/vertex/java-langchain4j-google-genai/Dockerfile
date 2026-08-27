FROM maven:3.9-eclipse-temurin-21-alpine
WORKDIR /app
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
CMD ["mvn", "-B", "-q", "compile", "exec:java"]
