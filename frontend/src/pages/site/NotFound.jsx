import { BigLink, Container, H1, Lead } from '../../components/site/parts.jsx';
import { PATHS } from '../../site/siteConfig.js';

export default function NotFound() {
  return (
    <section className="py-24">
      <Container>
        <H1>This page does not exist</H1>
        <Lead className="mt-5">The link may be old or mistyped. These pages will help.</Lead>
        <div className="mt-8 flex flex-wrap gap-3">
          <BigLink to={PATHS.home}>Go to the home page</BigLink>
          <BigLink to={PATHS.features} variant="outline">See features</BigLink>
          <BigLink to={PATHS.pricing} variant="outline">See pricing</BigLink>
        </div>
      </Container>
    </section>
  );
}
